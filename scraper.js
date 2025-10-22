const puppeteer = require('puppeteer-core');
const fs = require('fs');

// Configuration
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY;
const TARGET_URL = 'https://www.linkedin.com/ad-library/search?companyIds=89771&dateOption=last-30-days';
const BROWSERLESS_UNBLOCK_URL = 'https://production-sfo.browserless.io/chromium/unblock';
const TIMEOUT = 5 * 60 * 1000;

// Parse command-line arguments
const MAX_ADS = parseInt(process.argv[2]) || null;

async function scrapeLinkedInAds(maxAds = null) {
    if (!BROWSERLESS_API_KEY) {
        console.error('Error: BROWSERLESS_API_KEY environment variable not set');
        console.log('Please set your API key: export BROWSERLESS_API_KEY="your_key_here"');
        process.exit(1);
    }

    console.log('Starting LinkedIn Ad Library scraper...');
    console.log('Target URL:', TARGET_URL);
    
    let browser;
    try {
        // Use Browserless unblock endpoint with residential proxy
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
                url: TARGET_URL,
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
        console.log('Connected to browserless unblock endpoint');
        
        // Connect to the browser endpoint
        browser = await puppeteer.connect({
            browserWSEndpoint: `${browserWSEndpoint}?${queryParams}`
        });
        
        // Get the page that was already navigated to the URL
        const pages = await browser.pages();
        const page = pages.find((p) => p.url().includes(TARGET_URL.split('?')[0])) || pages[0];
        
        console.log('Page connected, current URL:', page.url());

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

        // Extract ads content
        const ads = await page.evaluate(() => {
            // Try multiple selectors for ad links
            const links = Array.from(document.querySelectorAll('a[href*="/ad-library/detail/"]'));
            return links
                .map(link => ({
                    url: link.href,
                    text: link.textContent?.trim() || '',
                    id: link.href.match(/detail\/(\d+)/)?.[1] || '',
                    html: link.innerHTML
                }))
                .filter(ad => ad.id); // Only include ads with valid IDs
        });

        // Limit ads if maxAds is specified
        const limitedAds = maxAds ? ads.slice(0, maxAds) : ads;
        
        console.log(`Found ${ads.length} ads${maxAds ? ` (limited to ${maxAds})` : ''}:`);
        limitedAds.slice(0, 5).forEach((ad, index) => {
            console.log(`${index + 1}. ID: ${ad.id}`);
            console.log(`   URL: ${ad.url}`);
            console.log(`   Text: ${ad.text.substring(0, 100)}...`);
        });

        // Save page content for debugging
        const pageContent = await page.content();
        fs.writeFileSync('linkedin-page.html', pageContent);
        console.log('\nPage HTML saved as linkedin-page.html');
        console.log('Page title:', await page.title());
        console.log('Page URL:', page.url());

        return { ads: limitedAds, totalFound: ads.length };

    } catch (error) {
        console.error('Error during scraping:', error.message);
        throw error;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// Run the scraper
scrapeLinkedInAds(MAX_ADS)
    .then((results) => {
        console.log('\nScraping completed successfully!');
        console.log(`Extracted ${results.ads.length} ads${MAX_ADS ? ` (limited to ${MAX_ADS})` : ''} out of ${results.totalFound} found`);
    })
    .catch((error) => {
        console.error('Scraping failed:', error);
        process.exit(1);
    });
