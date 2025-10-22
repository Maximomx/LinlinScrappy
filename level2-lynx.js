const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

async function scrapeAdDetailsWithLynx(adUrl) {
    try {
        // Use lynx to get the HTML
        const { stdout } = await execAsync(`lynx -source "${adUrl}" 2>/dev/null`);
        
        // Extract data from HTML
        const data = {
            adId: adUrl.match(/detail\/(\d+)/)?.[1] || null,
            sourceUrl: adUrl
        };

        // Extract headline from sponsored-content-headline
        let headlineMatch = stdout.match(/class="sponsored-content-headline[^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2/);
        if (!headlineMatch) {
            // Try alternative pattern
            headlineMatch = stdout.match(/class="sponsored-content-headline[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a/);
        }
        data.headline = headlineMatch ? headlineMatch[1].trim().replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&') : null;

        // Extract company name from advertiser link
        let companyMatch = stdout.match(/data-tracking-control-name="ad_library_ad_preview_advertiser"[^>]*>\s*<[^>]*>\s*<[^>]*>([\s\S]*?)<\//);
        if (!companyMatch) {
            companyMatch = stdout.match(/aria-label="View organization page[^"]*"[^>]*>([\s\S]*?)</);
        }
        if (!companyMatch) {
            companyMatch = stdout.match(/data-tracking-control-name="ad_library_ad_preview_advertiser"[^>]*>([\s\S]*?)</);
        }
        data.company = companyMatch ? companyMatch[1].trim().replace(/<[^>]*>/g, '').substring(0, 100) : null;

        // Extract main image URL (data-delayed-url for ad preview)
        const imageMatch = stdout.match(/class="ad-preview__dynamic-dimensions-image[^>]*data-delayed-url="([^"]+)"/);
        data.imageUrl = imageMatch ? imageMatch[1].replace(/&amp;/g, '&') : null;

        // Extract image alt text - look for alt text in the main ad image
        let imageAltMatch = stdout.match(/alt="([^"]+)"[^>]*class="ad-preview__dynamic-dimensions-image/);
        if (!imageAltMatch) {
            imageAltMatch = stdout.match(/class="ad-preview__dynamic-dimensions-image[^>]*alt="([^"]+)"/);
        }
        // If still not found, try any alt text that isn't 'advertiser logo'
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

        // Extract target URL (where the ad leads to)
        // Look for href values in ad_library_ad_preview_content_image or headline_content links
        let targetMatch = null;
        
        // First try content image link - handle potential line breaks
        const contentImageRegex = /data-tracking-control-name="ad_library_ad_preview_content_image"[\s\S]*?href="([^"]+)"/;
        targetMatch = stdout.match(contentImageRegex);
        
        // If not found, try headline content link
        if (!targetMatch) {
            const headlineRegex = /data-tracking-control-name="ad_library_ad_preview_headline_content"[\s\S]*?href="([^"]+)"/;
            targetMatch = stdout.match(headlineRegex);
        }
        
        // Extract and decode the URL
        if (targetMatch && targetMatch[1]) {
            let url = targetMatch[1].replace(/&amp;/g, '&');
            data.targetUrl = url;
        } else {
            data.targetUrl = null;
        }

        // Extract description/commentary text
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
        // Remove truncation button text if present
        if (description && description.includes('See more')) {
            description = description.split('See more')[0].trim();
        }
        data.description = description;

        // Extract company logo URL
        let logoMatch = stdout.match(/alt="advertiser logo"[^>]*data-delayed-url="([^"]+)"/);
        // Alternative pattern for logo
        if (!logoMatch) {
            logoMatch = stdout.match(/data-delayed-url="([^"]+)"[^>]*alt="advertiser logo"/);
        }
        // Try to find logo in src attribute
        if (!logoMatch) {
            logoMatch = stdout.match(/alt="advertiser logo"[^>]*src="([^"]+)"/);
        }
        data.logoUrl = logoMatch ? logoMatch[1].replace(/&amp;/g, '&') : null;

        // Extract ad format (try multiple patterns)
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

        return data;

    } catch (error) {
        throw new Error(`Failed to scrape ${adUrl}: ${error.message}`);
    }
}

async function processAdsFromFile(inputFile) {
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

    for (let i = 0; i < adsData.length; i++) {
        const ad = adsData[i];
        const adUrl = ad.url;
        const adId = ad.id;

        try {
            console.log(`[${i + 1}/${adsData.length}] Processing Ad ID: ${adId}`);
            
            const adDetails = await scrapeAdDetailsWithLynx(adUrl);
            
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

        // Very small delay between requests (lynx is fast)
        if (i < adsData.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    // Save results
    const timestamp = Date.now();
    const resultsFile = `ads_details_lynx_${timestamp}.json`;
    const errorsFile = `ads_errors_lynx_${timestamp}.json`;

    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    console.log(`Results saved to: ${resultsFile}`);

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
        console.error('Usage: node level2-lynx.js <input-json-file>');
        console.log('Example: node level2-lynx.js ads_list_1761067788115.json');
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

module.exports = { scrapeAdDetailsWithLynx, processAdsFromFile };
