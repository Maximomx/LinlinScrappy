const puppeteer = require('puppeteer-core');
const ImageDownloader = require('./image-downloader');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

// Configuration
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY;
const BROWSERLESS_UNBLOCK_URL = 'https://production-sfo.browserless.io/chromium/unblock';
const TIMEOUT = 5 * 60 * 1000;

class LinkedInAdScraper {
    constructor(options = {}) {
        this.options = {
            maxAdsToProcess: options.maxAdsToProcess || 10,
            downloadImages: options.downloadImages !== false,
            saveResults: options.saveResults !== false,
            delayBetweenRequests: options.delayBetweenRequests || 300,
            outputDir: options.outputDir || null
        };
        // Initialize ImageDownloader with custom directory if provided
        this.imageDownloader = this.options.outputDir 
            ? new ImageDownloader(this.options.outputDir)
            : new ImageDownloader();
    }
    
    async getUnblockEndpoint(targetUrl) {
        const queryParams = new URLSearchParams({
            timeout: TIMEOUT,
            proxy: 'residential',
            token: BROWSERLESS_API_KEY,
        }).toString();

        const unblockURL = `${BROWSERLESS_UNBLOCK_URL}?${queryParams}`;
        
        const options = {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                url: targetUrl,
                browserWSEndpoint: true,
                content: false,
                screenshot: false,
                ttl: 30000,
            }),
        };

        const response = await fetch(unblockURL, options);
        
        if (!response.ok) {
            throw new Error(`Got non-ok response: ${await response.text()}`);
        }
        
        const { browserWSEndpoint } = await response.json();
        return { browserWSEndpoint, queryParams };
    }

    async initBrowser(targetUrl) {
        if (!BROWSERLESS_API_KEY) {
            throw new Error('BROWSERLESS_API_KEY environment variable not set');
        }

        const { browserWSEndpoint, queryParams } = await this.getUnblockEndpoint(targetUrl);
        this.browser = await puppeteer.connect({
            browserWSEndpoint: `${browserWSEndpoint}?${queryParams}`
        });
        return this.browser;
    }

    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
        }
    }

    async level1Scraping(targetUrl) {
        console.log('\nLEVEL 1: Scraping ad URLs...');
        console.log('Target URL:', targetUrl);
        
        const pages = await this.browser.pages();
        const page = pages[0];
        
        try {
            console.log('Using pre-navigated page from unblock endpoint');
            await page.waitForSelector('body', { timeout: TIMEOUT });
            
            console.log('Scrolling to load ads...');
            await page.evaluate(async () => {
                for (let i = 0; i < 5; i++) {
                    window.scrollTo(0, document.body.scrollHeight);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            });
            
            await page.waitForTimeout(3000);

            console.log('Extracting ad links and detecting video ads...');
            const adLinks = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="/ad-library/detail/"]'));
                return links
                    .map(link => {
                        // Check multiple parent levels for video indicators
                        let parent = link;
                        let isVideoAd = false;
                        
                        // Check up to 5 levels up for video indicators
                        for (let i = 0; i < 5; i++) {
                            parent = parent.parentElement;
                            if (!parent) break;
                            
                            const text = parent.textContent || '';
                            const html = parent.innerHTML || '';
                            
                            // Check for various video indicators
                            if (text.includes('Video Ad') || 
                                text.includes('Video ad') ||
                                html.includes('video-player') ||
                                html.includes('data-test-ad-type="video"') ||
                                parent.querySelector('[data-test-ad-type="video"]') ||
                                parent.querySelector('.video-player')) {
                                isVideoAd = true;
                                break;
                            }
                        }
                        
                        return {
                            url: link.href,
                            id: link.href.match(/detail\/(\d+)/)?.[1] || '',
                            isVideo: isVideoAd
                        };
                    })
                    .filter(ad => ad.id);
            });

            // Remove duplicates
            const uniqueAds = Array.from(new Map(adLinks.map(ad => [ad.id, ad])).values());
            
            // Filter out video ads
            const nonVideoAds = uniqueAds.filter(ad => !ad.isVideo);
            const videoAds = uniqueAds.filter(ad => ad.isVideo);
            
            const adsToProcess = nonVideoAds.slice(0, this.options.maxAdsToProcess);
            
            console.log(`Found ${uniqueAds.length} total unique ads`);
            console.log(`  - ${nonVideoAds.length} static/image ads`);
            console.log(`  - ${videoAds.length} video ads (excluded)`);
            console.log(`Will process ${adsToProcess.length} ads (max: ${this.options.maxAdsToProcess})`);

            return adsToProcess;

        } finally {
            await page.close();
        }
    }

    async level2ScrapingWithLynx(adUrl) {
        try {
            const { stdout } = await execAsync(`lynx -source "${adUrl}" 2>/dev/null`);
            
            const data = {
                adId: adUrl.match(/detail\/(\d+)/)?.[1] || null,
                sourceUrl: adUrl
            };

            // Extract headline
            let headlineMatch = stdout.match(/class="sponsored-content-headline[^\>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2/);
            if (!headlineMatch) {
                headlineMatch = stdout.match(/class="sponsored-content-headline[^\>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a/);
            }
            data.headline = headlineMatch ? headlineMatch[1].trim().replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&') : null;

            // Extract company name
            let companyMatch = stdout.match(/data-tracking-control-name="ad_library_ad_preview_advertiser"[^>]*>\s*<[^>]*>\s*<[^>]*>([\s\S]*?)<\//);
            if (!companyMatch) {
                companyMatch = stdout.match(/aria-label="View organization page[^"]*"[^>]*>([\s\S]*?)</);
            }
            if (!companyMatch) {
                companyMatch = stdout.match(/data-tracking-control-name="ad_library_ad_preview_advertiser"[^>]*>([\s\S]*?)</);
            }
            data.company = companyMatch ? companyMatch[1].trim().replace(/<[^>]*>/g, '').substring(0, 100) : null;

            // Extract image URL
            const imageMatch = stdout.match(/class="ad-preview__dynamic-dimensions-image[^>]*data-delayed-url="([^"]+)"/);
            data.imageUrl = imageMatch ? imageMatch[1].replace(/&amp;/g, '&') : null;

            // Extract image alt text
            let imageAltMatch = stdout.match(/alt="([^"]+)"[^>]*class="ad-preview__dynamic-dimensions-image/);
            if (!imageAltMatch) {
                imageAltMatch = stdout.match(/class="ad-preview__dynamic-dimensions-image[^>]*alt="([^"]+)"/);
            }
            if (!imageAltMatch) {
                const allAlts = stdout.match(/alt="([^"]+)"/g);
                if (allAlts) {
                    for (const alt of allAlts) {
                        const match = alt.match(/alt="([^"]+)"/);
                        if (match && match[1] !== 'advertiser logo') {
                            imageAltMatch = match;
                            break;
                        }
                    }
                }
            }
            data.imageAlt = imageAltMatch ? imageAltMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : null;

            // Extract target URL
            const contentImageRegex = /data-tracking-control-name="ad_library_ad_preview_content_image"[\s\S]*?href="([^"]+)"/;
            let targetMatch = stdout.match(contentImageRegex);
            if (!targetMatch) {
                const headlineRegex = /data-tracking-control-name="ad_library_ad_preview_headline_content"[\s\S]*?href="([^"]+)"/;
                targetMatch = stdout.match(headlineRegex);
            }
            data.targetUrl = targetMatch && targetMatch[1] ? targetMatch[1].replace(/&amp;/g, '&') : null;

            // Extract description
            let descMatch = stdout.match(/class="commentary__content[^>]*>([\s\S]*?)<\/p>/);
            let description = null;
            if (descMatch) {
                description = descMatch[1]
                    .trim()
                    .replace(/<[^>]*>/g, '')
                    .replace(/&quot;/g, '"')
                    .replace(/&amp;/g, '&')
                    .replace(/&#x27;/g, "'")
                    .replace(/&#34;/g, '"')
                    .replace(/\n\s*\n/g, '\n')
                    .trim();
            }
            if (description && description.includes('See more')) {
                description = description.split('See more')[0].trim();
            }
            data.description = description;

            // Extract logo URL
            let logoMatch = stdout.match(/alt="advertiser logo"[^>]*data-delayed-url="([^"]+)"/);
            if (!logoMatch) {
                logoMatch = stdout.match(/data-delayed-url="([^"]+)"[^>]*alt="advertiser logo"/);
            }
            if (!logoMatch) {
                logoMatch = stdout.match(/alt="advertiser logo"[^>]*src="([^"]+)"/);
            }
            data.logoUrl = logoMatch ? logoMatch[1].replace(/&amp;/g, '&') : null;

            // Extract ad format
            let adFormat = null;
            const formatPatterns = [
                /Single Image Ad/,
                /Video Ad/,
                /Carousel Ad/,
                /Collection Ad/,
                /SPONSORED_STATUS_UPDATE/
            ];
            for (const pattern of formatPatterns) {
                const match = stdout.match(pattern);
                if (match) {
                    adFormat = match[0];
                    break;
                }
            }
            data.adFormat = adFormat;

            // Extract CTA (Call-To-Action) button text
            const ctaMatch = stdout.match(/data-tracking-control-name="ad_library_ad_detail_cta"[\s\S]*?>([\s\S]*?)<\/button/);
            data.cta = ctaMatch ? ctaMatch[1].trim().replace(/<[^>]*>/g, '') : null;

            return data;

        } catch (error) {
            throw new Error(`Failed to scrape ${adUrl}: ${error.message}`);
        }
    }

    async processAds(targetUrl, scrapingLevel = 3) {
        console.log('\n🚀 Starting LinkedIn Ad Scraper Pipeline (with Lynx Level 2)...');
        console.log(`Scraping Level: ${scrapingLevel}`);
        console.log('='.repeat(60));
        
        // Extract companyId from URL
        const companyIdMatch = targetUrl.match(/companyIds=([^&]+)/);
        const companyId = companyIdMatch ? companyIdMatch[1] : null;
        
        // Create output directory if not set
        if (!this.options.outputDir) {
            this.options.outputDir = this.createCompanyDirectory(companyId, targetUrl);
            // Reinitialize ImageDownloader with the new directory
            this.imageDownloader = new ImageDownloader(this.options.outputDir);
        }
        
        const startTime = Date.now();
        const results = {
            startTime: new Date().toISOString(),
            targetUrl,
            companyId,
            scrapingLevel,
            processedAds: [],
            downloadResults: [],
            summary: {
                totalAdsFound: 0,
                totalAdsProcessed: 0,
                successfulDetails: 0,
                failedDetails: 0,
                videoAdsSkipped: 0,
                successfulDownloads: 0,
                failedDownloads: 0
            }
        };

        try {
            // Level 1: Get ad URLs
            if (scrapingLevel >= 1) {
                await this.initBrowser(targetUrl);
                const adUrls = await this.level1Scraping(targetUrl);
                results.summary.totalAdsFound = adUrls.length;

                if (adUrls.length === 0) {
                    console.log('No ads found. Exiting.');
                    return results;
                }

                // Level 2: Extract ad details
                if (scrapingLevel >= 2) {
                    console.log('\nLEVEL 2: Extracting ad details (using Lynx)...');
                    console.log('='.repeat(50));
                    
                    // Track which companies have already had their logo downloaded
                    const downloadedLogosByCompany = new Set();

                    for (let i = 0; i < adUrls.length; i++) {
                        const adUrl = adUrls[i].url;
                        const adId = adUrls[i].id;
                        
                        console.log(`\n[${i + 1}/${adUrls.length}] Processing Ad ID: ${adId}`);
                        
                        try {
                            const adDetails = await this.level2ScrapingWithLynx(adUrl);
                            
                            if (adDetails && adDetails.headline) {
                                console.log(`  Headline: ${adDetails.headline.substring(0, 60)}...`);
                                console.log(`  Company: ${adDetails.company || 'N/A'}`);
                                console.log(`  Ad Format: ${adDetails.adFormat || 'N/A'}`);
                                
                                // Check if this is a video ad
                                const isVideoAd = adDetails.adFormat && adDetails.adFormat.toLowerCase().includes('video');
                                
                                if (isVideoAd) {
                                    console.log(`  SKIPPED: Video ad (no static image)`);
                                    results.summary.videoAdsSkipped++;
                                } else {
                                    // Update directory name with actual company name if this is the first ad
                                    if (results.processedAds.length === 0 && adDetails.company) {
                                        this.updateDirectoryWithCompanyName(adDetails.company, companyId);
                                    }
                                    
                                    results.processedAds.push(adDetails);
                                    results.summary.successfulDetails++;
                                    
                                    // Level 3: Download image and logo if enabled
                                    if (scrapingLevel >= 3) {
                                        // Download main ad image
                                        if (adDetails.imageUrl) {
                                            console.log(`  Downloading image...`);
                                            try {
                                                const downloadResults = await this.imageDownloader.downloadAdImages(adDetails);
                                                results.downloadResults.push({
                                                    adId: adDetails.adId,
                                                    results: downloadResults
                                                });
                                                
                                                const successfulDownloads = downloadResults.filter(r => !r.error).length;
                                                results.summary.successfulDownloads += successfulDownloads;
                                                results.summary.failedDownloads += downloadResults.length - successfulDownloads;
                                                
                                            } catch (error) {
                                                console.error(`  Failed to download image: ${error.message}`);
                                                results.summary.failedDownloads++;
                                            }
                                        }
                                        
                                        // Download company logo (only once per company)
                                        if (adDetails.logoUrl && companyId && !downloadedLogosByCompany.has(companyId)) {
                                            console.log(`  Downloading company logo...`);
                                            try {
                                                const ext = this.imageDownloader.getFileExtension(adDetails.logoUrl);
                                                const filename = `${companyId}_logo${ext}`;
                                                const logoResult = await this.imageDownloader.downloadImage(adDetails.logoUrl, filename);
                                                
                                                downloadedLogosByCompany.add(companyId);
                                                console.log(`  Logo downloaded: ${filename}`);
                                                
                                            } catch (error) {
                                                console.error(`  Failed to download logo: ${error.message}`);
                                            }
                                        }
                                    }
                                }
                                
                            } else {
                                console.log(`  No headline found`);
                                results.summary.failedDetails++;
                            }
                            
                        } catch (error) {
                            console.error(`  ERROR: ${error.message}`);
                            results.summary.failedDetails++;
                        }
                        
                        results.summary.totalAdsProcessed++;
                        
                        // Add delay between requests
                        if (i < adUrls.length - 1) {
                            await new Promise(resolve => setTimeout(resolve, this.options.delayBetweenRequests));
                        }
                    }
                }
            }

            results.endTime = new Date().toISOString();
            results.duration = Date.now() - startTime;

            this.printSummary(results);
            
            if (this.options.saveResults) {
                this.saveResults(results);
            }

            return results;

        } finally {
            await this.closeBrowser();
        }
    }

    printSummary(results) {
        console.log('\n' + '='.repeat(60));
        console.log('SCRAPING SUMMARY');
        console.log('='.repeat(60));
        console.log(`Duration: ${Math.round(results.duration / 1000)}s`);
        console.log(`Ads found: ${results.summary.totalAdsFound}`);
        console.log(`Ads processed: ${results.summary.totalAdsProcessed}`);
        console.log(`Successful details: ${results.summary.successfulDetails}`);
        console.log(`Video ads skipped: ${results.summary.videoAdsSkipped}`);
        console.log(`Failed details: ${results.summary.failedDetails}`);
        
        if (this.options.downloadImages) {
            console.log(`Successful downloads: ${results.summary.successfulDownloads}`);
            console.log(`Failed downloads: ${results.summary.failedDownloads}`);
        }
        console.log('='.repeat(60));
    }

    sanitizeDirectoryName(name) {
        // Remove special characters and limit length
        return name
            .replace(/[^a-zA-Z0-9\s-]/g, '')
            .replace(/\s+/g, '_')
            .substring(0, 50)
            .toLowerCase();
    }
    
    createCompanyDirectory(companyId, targetUrl) {
        // Get company name from first scraped ad or use companyId
        let dirName = companyId ? `company_${companyId}` : 'company_unknown';
        const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
        const fullDirName = `${dirName}_${timestamp}`;
        const dirPath = path.join('./', fullDirName);
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            console.log(`Created output directory: ${fullDirName}`);
        }
        
        this.originalDirPath = dirPath;
        return dirPath;
    }
    
    updateDirectoryWithCompanyName(companyName, companyId) {
        if (!this.originalDirPath || !companyName) return;
        
        const sanitizedName = this.sanitizeDirectoryName(companyName);
        const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
        const newDirName = `${sanitizedName}_${timestamp}`;
        const newDirPath = path.join('./', newDirName);
        
        // Rename directory if company name is available
        try {
            if (fs.existsSync(this.originalDirPath) && this.originalDirPath !== newDirPath) {
                fs.renameSync(this.originalDirPath, newDirPath);
                console.log(`Renamed directory to: ${newDirName}`);
                this.options.outputDir = newDirPath;
                this.imageDownloader = new ImageDownloader(newDirPath);
            }
        } catch (error) {
            console.error(`Failed to rename directory: ${error.message}`);
        }
    }
    
    saveResults(results) {
        const timestamp = Date.now();
        const filename = `scraping_results_lynx_${timestamp}.json`;
        const filepath = path.join(this.options.outputDir || './', filename);
        
        fs.writeFileSync(filepath, JSON.stringify(results, null, 2));
        console.log(`Results saved to: ${filepath}`);
    }
}

// Main execution
async function main() {
    const targetUrl = process.argv[2];
    const maxAds = parseInt(process.argv[3]) || 10;
    const scrapingLevel = parseInt(process.argv[4]) || 3;
    
    if (!targetUrl) {
        console.error('Error: Please provide a LinkedIn Ad Library URL as an argument');
        console.log('\nUsage: node main-scraper-lynx.js "<url>" [maxAds] [scrapingLevel]');
        console.log('\nScrapingLevel options:');
        console.log('  1 - Level 1: Find ad URLs only');
        console.log('  2 - Level 1 + Level 2: Find ads and extract details');
        console.log('  3 - Level 1 + Level 2 + Level 3: Extract details and download images (default)');
        console.log('\nExample: node main-scraper-lynx.js "https://www.linkedin.com/ad-library/search?companyIds=89771" 20 2');
        process.exit(1);
    }

    // Validate scraping level
    if (scrapingLevel < 1 || scrapingLevel > 3) {
        console.error('Error: Scraping level must be 1, 2, or 3');
        process.exit(1);
    }

    const scraper = new LinkedInAdScraper({
        maxAdsToProcess: maxAds,
        downloadImages: scrapingLevel >= 3,
        saveResults: true,
        delayBetweenRequests: 300
    });

    try {
        await scraper.processAds(targetUrl, scrapingLevel);
        console.log('\nScraping pipeline completed successfully!');
    } catch (error) {
        console.error('Scraping pipeline failed:', error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = LinkedInAdScraper;
