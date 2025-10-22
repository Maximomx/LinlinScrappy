const puppeteer = require('puppeteer-core');
const fs = require('fs');

// Configuration
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY;
const BROWSERLESS_UNBLOCK_URL = 'https://production-sfo.browserless.io/chromium/unblock';
const TIMEOUT = 5 * 60 * 1000;

// Parse command-line arguments
const MAX_ADS = parseInt(process.argv[2]) || null;

async function scrapeAdDetails(adUrl, maxAds = null) {
    if (!BROWSERLESS_API_KEY) {
        console.error('Error: BROWSERLESS_API_KEY environment variable not set');
        console.log('Please set your API key: export BROWSERLESS_API_KEY="your_key_here"');
        process.exit(1);
    }

    console.log('Starting Level 2 scraping for ad details...');
    console.log('Target URL:', adUrl);
    
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
                url: adUrl,
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
        const page = pages.find((p) => p.url().includes('ad-library')) || pages[0];
        
        console.log('Page connected, current URL:', page.url());

        console.log('Page loaded. Extracting ad details...');
        
        // Wait for initial content
        await page.waitForSelector('body', { timeout: TIMEOUT });
        
        // Wait for content to fully load
        await page.waitForTimeout(2000);

        // Extract ad details
        const adDetails = await page.evaluate(() => {
            const data = {};
            
            // Extract ad ID from URL
            const urlMatch = window.location.href.match(/detail\/(\d+)/);
            data.adId = urlMatch ? urlMatch[1] : null;
            
            // Extract ad headline from the sponsored content
            const headlineElement = document.querySelector('.sponsored-content-headline h2') ||
                                   document.querySelector('h2.text-sm.font-semibold');
            data.headline = headlineElement ? headlineElement.textContent.trim() : null;
            
            // Extract ad description/commentary text
            const descriptionElement = document.querySelector('.commentary__content');
            data.description = descriptionElement ? descriptionElement.textContent.trim() : null;
            
            // Extract company/advertiser name
            const companyElement = document.querySelector('a[data-tracking-control-name="ad_library_ad_preview_advertiser"]');
            data.company = companyElement ? companyElement.textContent.trim() : null;
            
            // Extract company logo URL
            const logoElement = document.querySelector('img[alt="advertiser logo"]');
            data.logoUrl = logoElement ? logoElement.src : null;
            
            // Extract main ad image URL
            const imageElement = document.querySelector('.ad-preview__dynamic-dimensions-image');
            data.imageUrl = imageElement ? imageElement.src : null;
            data.imageAlt = imageElement ? imageElement.alt : null;
            
            // Extract target URL (where the ad leads)
            const targetLinkElement = document.querySelector('a[data-tracking-control-name="ad_library_ad_preview_content_image"]') ||
                                    document.querySelector('a[data-tracking-control-name="ad_library_ad_preview_headline_content"]');
            data.targetUrl = targetLinkElement ? targetLinkElement.href : null;
            
            // Extract ad format/type from the data attribute
            const adPreviewElement = document.querySelector('.ad-preview');
            data.adFormat = adPreviewElement ? adPreviewElement.getAttribute('data-creative-type') : null;
            
            // Extract company URL
            const companyLinkElement = document.querySelector('a[href*="/company/"]');
            data.companyUrl = companyLinkElement ? companyLinkElement.href : null;
            
            // Extract promoted text
            const promotedElement = document.querySelector('p[data-tracking-control-name="ad_library_ad_preview_advertiser_generic_entity"]');
            data.promotedText = promotedElement ? promotedElement.textContent.trim() : null;
            
            // Check if there's a "see more" button (indicating truncated content)
            const seeMoreButton = document.querySelector('.commentary__truncation-button');
            data.hasMoreContent = seeMoreButton ? !seeMoreButton.classList.contains('invisible') : false;
            
            // Get page title
            data.pageTitle = document.title;
            
            // Get current URL
            data.currentUrl = window.location.href;
            
            return data;
        });

        // Take screenshot for debugging
        await page.screenshot({ path: `ad-detail-${adDetails.adId || 'unknown'}.png`, fullPage: true });
        console.log(`Screenshot saved as ad-detail-${adDetails.adId || 'unknown'}.png`);

        // Save HTML content for debugging
        const pageContent = await page.content();
        fs.writeFileSync(`ad-detail-${adDetails.adId || 'unknown'}.html`, pageContent);
        console.log(`Page HTML saved as ad-detail-${adDetails.adId || 'unknown'}.html`);

        // Log extracted details
        console.log('\nExtracted Ad Details:');
        console.log('=====================');
        console.log('Ad ID:', adDetails.adId);
        console.log('Headline:', adDetails.headline);
        console.log('Description:', adDetails.description);
        console.log('Company:', adDetails.company);
        console.log('Company URL:', adDetails.companyUrl);
        console.log('Logo URL:', adDetails.logoUrl);
        console.log('Image URL:', adDetails.imageUrl);
        console.log('Image Alt Text:', adDetails.imageAlt);
        console.log('Target URL:', adDetails.targetUrl);
        console.log('Ad Format:', adDetails.adFormat);
        console.log('Promoted Text:', adDetails.promotedText);
        console.log('Has More Content:', adDetails.hasMoreContent);
        console.log('Page Title:', adDetails.pageTitle);
        console.log('Current URL:', adDetails.currentUrl);

        return adDetails;

    } catch (error) {
        console.error('Error during level 2 scraping:', error.message);
        throw error;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// Test with the provided URL
const testUrl = 'https://www.linkedin.com/ad-library/detail/878430633?trk=ad_library_ad_preview_content_image';

scrapeAdDetails(testUrl)
    .then((adDetails) => {
        console.log('\nLevel 2 scraping completed successfully!');
        console.log('Extracted data for ad ID:', adDetails.adId);
    })
    .catch((error) => {
        console.error('Level 2 scraping failed:', error);
        process.exit(1);
    });