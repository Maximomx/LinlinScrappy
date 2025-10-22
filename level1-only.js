const puppeteer = require('puppeteer-core');
const fs = require('fs');

// Configuration
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY;
const BROWSERLESS_UNBLOCK_URL = 'https://production-sfo.browserless.io/chromium/unblock';
const TIMEOUT = 5 * 60 * 1000;

async function scrapeAdList(targetUrl, maxAds = 30) {
    if (!BROWSERLESS_API_KEY) {
        console.error('Error: BROWSERLESS_API_KEY environment variable not set');
        process.exit(1);
    }

    console.log('Starting Level 1 scraping (finding ads)...');
    console.log('Target URL:', targetUrl);
    console.log('Max ads to find:', maxAds);
    
    let browser;
    try {
        // Use Browserless unblock endpoint
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

        console.log('Requesting unblock endpoint...');
        const response = await fetch(unblockURL, options);
        
        if (!response.ok) {
            throw new Error(`Got non-ok response: ${await response.text()}`);
        }
        
        const { browserWSEndpoint } = await response.json();
        console.log('Connected to browserless unblock endpoint\n');
        
        // Connect to the browser endpoint
        browser = await puppeteer.connect({
            browserWSEndpoint: `${browserWSEndpoint}?${queryParams}`
        });
        
        // Get the page that was already navigated to the URL
        const pages = await browser.pages();
        const page = pages[0];
        
        console.log('Page connected, current URL:', page.url());
        
        // Wait for initial content
        await page.waitForSelector('body', { timeout: TIMEOUT });
        
        // Scroll multiple times to load all ads
        console.log('Scrolling to load ads...');
        for (let i = 0; i < 5; i++) {
            console.log(`Scroll ${i + 1}/5...`);
            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
            });
            await page.waitForTimeout(2000);
        }
        
        // Wait for ads to load
        await page.waitForTimeout(3000);

        // Extract all ad links
        console.log('Extracting ad links...\n');
        const allAds = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/ad-library/detail/"]'));
            return links
                .map(link => ({
                    url: link.href,
                    id: link.href.match(/detail\/(\d+)/)?.[1] || '',
                    text: link.textContent?.trim() || ''
                }))
                .filter(ad => ad.id); // Only ads with valid IDs
        });

        // Remove duplicates by ID
        const uniqueAds = Array.from(new Map(allAds.map(ad => [ad.id, ad])).values());
        
        // Limit to maxAds
        const adsToReturn = uniqueAds.slice(0, maxAds);
        
        console.log(`Found ${uniqueAds.length} total unique ads`);
        console.log(`Returning ${adsToReturn.length} ads\n`);
        console.log('='.repeat(80));
        
        // Display the ads
        adsToReturn.forEach((ad, index) => {
            console.log(`${index + 1}. Ad ID: ${ad.id}`);
            console.log(`   URL: ${ad.url}`);
            console.log('');
        });

        // Save to JSON file
        const filename = `ads_list_${Date.now()}.json`;
        fs.writeFileSync(filename, JSON.stringify(adsToReturn, null, 2));
        console.log(`Results saved to: ${filename}`);

        return adsToReturn;

    } catch (error) {
        console.error('Error during scraping:', error.message);
        throw error;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// Main
async function main() {
    const targetUrl = process.argv[2] || 'https://www.linkedin.com/ad-library/search?companyIds=36076&dateOption=last-30-days';
    const maxAds = parseInt(process.argv[3]) || 30;
    
    try {
        await scrapeAdList(targetUrl, maxAds);
        console.log('\nScraping completed successfully!');
    } catch (error) {
        console.error('Scraping failed:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = scrapeAdList;
