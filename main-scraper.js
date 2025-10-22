const puppeteer = require('puppeteer-core');
const ImageDownloader = require('./image-downloader');
const fs = require('fs');
const path = require('path');

// Configuration
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY;
const BROWSERLESS_UNBLOCK_URL = 'https://production-sfo.browserless.io/chromium/unblock';
const TIMEOUT = 5 * 60 * 1000;

class LinkedInAdScraper {
    constructor(options = {}) {
        this.imageDownloader = new ImageDownloader();
        this.options = {
            maxAdsToProcess: options.maxAdsToProcess || 10,
            downloadImages: options.downloadImages !== false, // true by default
            saveResults: options.saveResults !== false, // true by default
            delayBetweenRequests: options.delayBetweenRequests || 3000
        };
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

    async setupPage() {
        const page = await this.browser.newPage();
        
        // Set viewport and user agent for better stealth
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Add extra headers to appear more human-like
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        });

        return page;
    }

    async level1Scraping(targetUrl) {
        console.log('\nLEVEL 1: Scraping ad URLs...');
        console.log('Target URL:', targetUrl);
        
        const pages = await this.browser.pages();
        const page = pages.find((p) => p.url().includes('ad-library')) || pages[0];
        
        try {
            console.log('Using pre-navigated page from unblock endpoint');

            console.log('Page loaded. Waiting for content...');
            
            // Wait for initial content
            await page.waitForSelector('body', { timeout: TIMEOUT });
            
            // Scroll twice to load ads
            console.log('Scrolling to load ads...');
            await page.evaluate(async () => {
                // First scroll
                window.scrollTo(0, document.body.scrollHeight);
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Second scroll
                window.scrollTo(0, document.body.scrollHeight);
                await new Promise(resolve => setTimeout(resolve, 2000));
            });
            
            // Wait for ads to load
            await page.waitForTimeout(3000);

            // Extract ad links with preview content images
            console.log('Searching for ad preview links...');
            const adLinks = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*=\"/ad-library/detail/\"]'));
                return links
                    .filter(link => link.href.includes('ad_preview_content_image'))
                    .map(link => ({
                        url: link.href,
                        text: link.textContent?.trim() || '',
                        id: link.href.match(/detail\/(\d+)/)?.[1] || ''
                    }));
            });

            console.log(`✅ Found ${adLinks.length} ads with preview images`);
            
            // Limit the number of ads to process
            const adsToProcess = adLinks.slice(0, this.options.maxAdsToProcess);
            console.log(`📝 Will process ${adsToProcess.length} ads (max: ${this.options.maxAdsToProcess})`);

            return adsToProcess;

        } finally {
            await page.close();
        }
    }

    async level2Scraping(adUrl) {
        let browser;
        let page;
        let useUnblock = false;
        
        try {
            // Try direct connection first
            try {
                page = await this.browser.newPage();
                await page.goto(adUrl, { 
                    waitUntil: 'networkidle2',
                    timeout: 15000 
                });
                await page.waitForTimeout(1000);
                
                // Check if page loaded successfully
                const pageTitle = await page.title();
                if (!pageTitle || pageTitle.includes('Error') || pageTitle.includes('403')) {
                    throw new Error('Page blocked or error');
                }
            } catch (directError) {
                // Direct connection failed, try unblock endpoint
                console.log(`   Direct connection failed, using unblock endpoint...`);
                useUnblock = true;
                if (page) await page.close();
                
                const { browserWSEndpoint, queryParams } = await this.getUnblockEndpoint(adUrl);
                browser = await puppeteer.connect({
                    browserWSEndpoint: `${browserWSEndpoint}?${queryParams}`
                });
                
                const pages = await browser.pages();
                page = pages[0];
                
                await page.waitForSelector('body', { timeout: TIMEOUT });
                await page.waitForTimeout(1000);
            }

            // Extract ad details
            const adDetails = await page.evaluate(() => {
                const data = {};
                
                const urlMatch = window.location.href.match(/detail\/(\d+)/);
                data.adId = urlMatch ? urlMatch[1] : null;
                
                const headlineElement = document.querySelector('.sponsored-content-headline h2') ||
                                       document.querySelector('h2.text-sm.font-semibold');
                data.headline = headlineElement ? headlineElement.textContent.trim() : null;
                
                const descriptionElement = document.querySelector('.commentary__content');
                data.description = descriptionElement ? descriptionElement.textContent.trim() : null;
                
                const companyElement = document.querySelector('a[data-tracking-control-name=\"ad_library_ad_preview_advertiser\"]');
                data.company = companyElement ? companyElement.textContent.trim() : null;
                
                const imageElement = document.querySelector('.ad-preview__dynamic-dimensions-image');
                data.imageUrl = imageElement ? imageElement.src : null;
                data.imageAlt = imageElement ? imageElement.alt : null;
                
                const targetLinkElement = document.querySelector('a[data-tracking-control-name=\"ad_library_ad_preview_content_image\"]') ||
                                        document.querySelector('a[data-tracking-control-name=\"ad_library_ad_preview_headline_content\"]');
                data.targetUrl = targetLinkElement ? targetLinkElement.href : null;
                
                const adPreviewElement = document.querySelector('.ad-preview');
                data.adFormat = adPreviewElement ? adPreviewElement.getAttribute('data-creative-type') : null;
                
                data.sourceUrl = window.location.href;
                
                return data;
            });

            return adDetails;

        } catch (error) {
            throw error;
        } finally {
            if (page) await page.close();
            if (useUnblock && browser) await browser.close();
        }
    }

    async processAds(targetUrl) {
        console.log('\n🚀 Starting LinkedIn Ad Scraper Pipeline...');
        console.log('='.repeat(60));
        
        const startTime = Date.now();
        const results = {
            startTime: new Date().toISOString(),
            targetUrl,
            processedAds: [],
            downloadResults: [],
            summary: {
                totalAdsFound: 0,
                totalAdsProcessed: 0,
                successfulDetails: 0,
                failedDetails: 0,
                successfulDownloads: 0,
                failedDownloads: 0
            }
        };

        try {
            await this.initBrowser(targetUrl);

            // Level 1: Get ad URLs
            const adUrls = await this.level1Scraping(targetUrl);
            results.summary.totalAdsFound = adUrls.length;

            if (adUrls.length === 0) {
                console.log('❌ No ads found. Exiting.');
                return results;
            }

            console.log('\nLEVEL 2: Extracting ad details...');
            console.log('='.repeat(50));

            // Level 2: Process each ad
            for (let i = 0; i < adUrls.length; i++) {
                const adUrl = adUrls[i].url;
                const adId = adUrls[i].id;
                
                console.log(`\n[${i + 1}/${adUrls.length}] Processing Ad ID: ${adId}`);
                console.log(`URL: ${adUrl}`);
                
                try {
                    const adDetails = await this.level2Scraping(adUrl);
                    
                    if (adDetails.imageUrl) {
                        console.log(`✅ Extracted details for ad ${adDetails.adId}`);
                        console.log(`   Headline: ${adDetails.headline}`);
                        console.log(`   Company: ${adDetails.company}`);
                        
                        results.processedAds.push(adDetails);
                        results.summary.successfulDetails++;
                        
                        // Level 3: Download image if enabled
                        if (this.options.downloadImages) {
                            console.log(`📥 Downloading image for ad ${adDetails.adId}...`);
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
                                console.error(`❌ Failed to download image for ad ${adDetails.adId}: ${error.message}`);
                                results.summary.failedDownloads++;
                            }
                        }
                        
                    } else {
                        console.log(`⚠️  No image URL found for ad ${adId}`);
                        results.summary.failedDetails++;
                    }
                    
                } catch (error) {
                    console.error(`❌ Failed to process ad ${adId}: ${error.message}`);
                    results.summary.failedDetails++;
                }
                
                results.summary.totalAdsProcessed++;
                
                // Add delay between requests
                if (i < adUrls.length - 1) {
                    console.log(`⏳ Waiting ${this.options.delayBetweenRequests/1000}s before next request...`);
                    await new Promise(resolve => setTimeout(resolve, this.options.delayBetweenRequests));
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
        console.log(`Failed details: ${results.summary.failedDetails}`);
        
        if (this.options.downloadImages) {
            console.log(`Successful downloads: ${results.summary.successfulDownloads}`);
            console.log(`Failed downloads: ${results.summary.failedDownloads}`);
        }
        console.log('='.repeat(60));
    }

    saveResults(results) {
        const timestamp = Date.now();
        const filename = `scraping_results_${timestamp}.json`;
        const filepath = path.join('./', filename);
        
        fs.writeFileSync(filepath, JSON.stringify(results, null, 2));
        console.log(`💾 Results saved to: ${filename}`);
    }
}

// Main execution
async function main() {
    const targetUrl = process.argv[2];
    const maxAds = parseInt(process.argv[3]) || 10;
    
    if (!targetUrl) {
        console.error('Error: Please provide a LinkedIn Ad Library URL as an argument');
        console.log('Usage: node main-scraper.js "<linkedin-ad-library-url>" [maxAds]');
        console.log('Example: node main-scraper.js "https://www.linkedin.com/ad-library/search?companyIds=89771" 20');
        process.exit(1);
    }

    const scraper = new LinkedInAdScraper({
        maxAdsToProcess: maxAds,
        downloadImages: true,
        saveResults: true,
        delayBetweenRequests: 1000
    });

    try {
        await scraper.processAds(targetUrl);
        console.log('\nScraping pipeline completed successfully!');
    } catch (error) {
        console.error('Scraping pipeline failed:', error.message);
        process.exit(1);
    }
}

// Export for use as module
module.exports = LinkedInAdScraper;

// Run if executed directly
if (require.main === module) {
    main();
}