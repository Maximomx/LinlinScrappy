const puppeteer = require('puppeteer-core');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execAsync = promisify(exec);

// Configuration
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY;
const BROWSERLESS_UNBLOCK_URL = 'https://production-sfo.browserless.io/chromium/unblock';
const TIMEOUT = 5 * 60 * 1000;

function sanitizeDirectoryName(name) {
    return name
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 50)
        .toLowerCase();
}

async function getCompanyName(targetUrl) {
    console.log('Extracting company name from page...');
    try {
        const { stdout } = await execAsync(`lynx -dump "${targetUrl}" 2>/dev/null`);
        
        // Look for company name before "Promoted" text
        const lines = stdout.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() === 'Promoted' && i > 0) {
                // Check previous line for company name
                const prevLine = lines[i - 1].trim();
                if (prevLine && prevLine !== 'advertiser logo' && prevLine.length > 0) {
                    console.log(`Found company name: ${prevLine}`);
                    return prevLine;
                }
            }
        }
        
        console.log('Company name not found in page');
        return null;
    } catch (error) {
        console.error('Error extracting company name:', error.message);
        return null;
    }
}

function createCompanyDirectory(companyName, companyId) {
    const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
    let baseDirName;
    
    if (companyName) {
        const sanitizedName = sanitizeDirectoryName(companyName);
        baseDirName = `${sanitizedName}_${timestamp}`;
    } else if (companyId) {
        baseDirName = `company_${companyId}_${timestamp}`;
    } else {
        baseDirName = `company_unknown_${timestamp}`;
    }
    
    // Check if directory exists and append run number if needed
    let dirPath = path.join('./', baseDirName);
    let runNumber = 1;
    
    while (fs.existsSync(dirPath)) {
        dirPath = path.join('./', `${baseDirName}_run${runNumber}`);
        runNumber++;
    }
    
    fs.mkdirSync(dirPath, { recursive: true });
    const finalDirName = path.basename(dirPath);
    console.log(`Created output directory: ${finalDirName}\n`);
    
    return dirPath;
}

async function scrapeAdList(targetUrl, maxAds = 30) {
    if (!BROWSERLESS_API_KEY) {
        console.error('Error: BROWSERLESS_API_KEY environment variable not set');
        process.exit(1);
    }

    console.log('Starting Level 1 scraping (finding ads)...');
    console.log('Target URL:', targetUrl);
    console.log('Max ads to find:', maxAds);
    
    const companyIdMatch = targetUrl.match(/companyIds=([^&]+)/);
    const companyId = companyIdMatch ? companyIdMatch[1] : null;
    
    const companyName = await getCompanyName(targetUrl);
    const outputDir = createCompanyDirectory(companyName, companyId);
    
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

        // Save to JSON file in the company directory
        const filename = `ads_list_${Date.now()}.json`;
        const filepath = path.join(outputDir, filename);
        const resultData = {
            companyName,
            companyId,
            targetUrl,
            scrapedAt: new Date().toISOString(),
            totalAds: adsToReturn.length,
            ads: adsToReturn
        };
        fs.writeFileSync(filepath, JSON.stringify(resultData, null, 2));
        console.log(`Results saved to: ${filepath}`);

        return { outputDir, ads: adsToReturn, companyName, companyId };

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
