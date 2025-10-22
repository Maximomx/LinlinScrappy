const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// Configuration
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY;
const BROWSERLESS_UNBLOCK_URL = 'https://production-sfo.browserless.io/chromium/unblock';
const TIMEOUT = 5 * 60 * 1000;

async function getUnblockEndpoint(targetUrl) {
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

async function scrapeAdDetails(adUrl, existingBrowser = null) {
    let browser;
    let page;
    let useUnblock = false;
    
    try {
        // Try direct connection first if we have an existing browser
        if (existingBrowser) {
            try {
                page = await existingBrowser.newPage();
                await page.goto(adUrl, { 
                    waitUntil: 'networkidle2',
                    timeout: 10000 
                });
                await page.waitForTimeout(800);
                
                // Check if page loaded successfully
                const pageTitle = await page.title();
                if (!pageTitle || pageTitle.includes('Error') || pageTitle.includes('403')) {
                    throw new Error('Page blocked or error');
                }
            } catch (directError) {
                // Direct connection failed, try unblock endpoint
                useUnblock = true;
                if (page) await page.close();
                page = null;
                
                const { browserWSEndpoint, queryParams } = await getUnblockEndpoint(adUrl);
                browser = await puppeteer.connect({
                    browserWSEndpoint: `${browserWSEndpoint}?${queryParams}`
                });
                
                const pages = await browser.pages();
                page = pages[0];
                
                await page.waitForSelector('body', { timeout: TIMEOUT });
                await page.waitForTimeout(1000);
            }
        } else {
            // No existing browser, use unblock endpoint directly
            useUnblock = true;
            const { browserWSEndpoint, queryParams } = await getUnblockEndpoint(adUrl);
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
            
            const companyElement = document.querySelector('a[data-tracking-control-name="ad_library_ad_preview_advertiser"]');
            data.company = companyElement ? companyElement.textContent.trim() : null;
            
            const logoElement = document.querySelector('img[alt="advertiser logo"]');
            data.logoUrl = logoElement ? logoElement.src : null;
            
            const imageElement = document.querySelector('.ad-preview__dynamic-dimensions-image');
            data.imageUrl = imageElement ? imageElement.src : null;
            data.imageAlt = imageElement ? imageElement.alt : null;
            
            const targetLinkElement = document.querySelector('a[data-tracking-control-name="ad_library_ad_preview_content_image"]') ||
                                    document.querySelector('a[data-tracking-control-name="ad_library_ad_preview_headline_content"]');
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

async function processAdsFromFile(inputFile) {
    if (!BROWSERLESS_API_KEY) {
        console.error('Error: BROWSERLESS_API_KEY environment variable not set');
        process.exit(1);
    }

    // Read input JSON file
    if (!fs.existsSync(inputFile)) {
        console.error(`File not found: ${inputFile}`);
        process.exit(1);
    }

    const adsData = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
    console.log(`Processing ${adsData.length} ads from ${inputFile}\n`);
    console.log('='.repeat(80));

    const results = [];
    const errors = [];
    
    // Create a persistent browser connection for direct attempts
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
    } catch (e) {
        console.warn('Could not create local browser, will use unblock endpoint only\n');
    }

    for (let i = 0; i < adsData.length; i++) {
        const ad = adsData[i];
        const adUrl = ad.url;
        const adId = ad.id;

        try {
            console.log(`[${i + 1}/${adsData.length}] Processing Ad ID: ${adId}`);
            
            const adDetails = await scrapeAdDetails(adUrl, browser);
            
            if (adDetails) {
                console.log(`  Headline: ${adDetails.headline?.substring(0, 60) || 'N/A'}...`);
                console.log(`  Company: ${adDetails.company || 'N/A'}`);
                console.log(`  Status: OK\n`);
                
                results.push(adDetails);
            }
        } catch (error) {
            console.error(`  ERROR: ${error.message}\n`);
            errors.push({
                adId,
                url: adUrl,
                error: error.message
            });
        }

        // Small delay between requests
        if (i < adsData.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }
    
    // Close persistent browser connection
    if (browser) {
        await browser.close();
    }

    // Save results
    const timestamp = Date.now();
    const resultsFile = `ads_details_${timestamp}.json`;
    const errorsFile = `ads_errors_${timestamp}.json`;

    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    console.log(`\nResults saved to: ${resultsFile}`);

    if (errors.length > 0) {
        fs.writeFileSync(errorsFile, JSON.stringify(errors, null, 2));
        console.log(`Errors saved to: ${errorsFile}`);
    }

    // Print summary
    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total processed: ${adsData.length}`);
    console.log(`Successful: ${results.length}`);
    console.log(`Failed: ${errors.length}`);

    return { results, errors };
}

// Main
async function main() {
    const inputFile = process.argv[2];
    
    if (!inputFile) {
        console.error('Usage: node level2-batch.js <input-json-file>');
        console.log('Example: node level2-batch.js ads_list_1761067788115.json');
        process.exit(1);
    }

    try {
        await processAdsFromFile(inputFile);
        console.log('\nBatch processing completed successfully!');
    } catch (error) {
        console.error('Batch processing failed:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { scrapeAdDetails, processAdsFromFile };
