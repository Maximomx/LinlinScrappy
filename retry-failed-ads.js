const LinkedInAdScraper = require('./main-scraper-lynx');
const fs = require('fs');
const path = require('path');

/**
 * Retry failed ads from a previous scraping run
 * 
 * Usage:
 *   node retry-failed-ads.js <results_json_file> [scrapingLevel]
 * 
 * Example:
 *   node retry-failed-ads.js company_89771_20251022/scraping_results_lynx_1761154119634.json 3
 */

async function retryFailedAds() {
    const resultsFile = process.argv[2];
    const scrapingLevel = parseInt(process.argv[3]) || 3;
    
    if (!resultsFile) {
        console.error('Error: Please provide a results JSON file');
        console.log('\nUsage: node retry-failed-ads.js <results_json_file> [scrapingLevel]');
        console.log('\nExample:');
        console.log('  node retry-failed-ads.js company_89771_20251022/scraping_results_lynx_1761154119634.json 3');
        process.exit(1);
    }
    
    // Check if file exists
    if (!fs.existsSync(resultsFile)) {
        console.error(`Error: File not found: ${resultsFile}`);
        process.exit(1);
    }
    
    // Read previous results
    console.log(`Reading previous results from: ${resultsFile}`);
    const previousResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    
    // Check if there are failed ads
    if (!previousResults.failedAds || previousResults.failedAds.length === 0) {
        console.log('No failed ads to retry.');
        console.log('\nNote: This results file may be from an older version that didn\'t track failed ads.');
        console.log('Re-run the original scraping command to generate a new results file with failure tracking.');
        process.exit(0);
    }
    
    console.log(`\nFound ${previousResults.failedAds.length} failed ads to retry:`);
    previousResults.failedAds.forEach((ad, index) => {
        console.log(`  ${index + 1}. Ad ID ${ad.adId} - Reason: ${ad.reason}`);
    });
    
    // Get output directory from results file path
    const outputDir = path.dirname(resultsFile);
    const companyId = previousResults.companyId;
    
    // Create scraper instance
    const scraper = new LinkedInAdScraper({
        maxAdsToProcess: previousResults.failedAds.length,
        downloadImages: scrapingLevel >= 3,
        saveResults: true,
        delayBetweenRequests: 500, // Slightly longer delay for retries
        outputDir: outputDir
    });
    
    console.log(`\nRetrying ${previousResults.failedAds.length} ads...`);
    console.log('='.repeat(60));
    
    // Initialize browser
    await scraper.initBrowser(previousResults.targetUrl);
    
    const results = {
        startTime: new Date().toISOString(),
        originalResultsFile: resultsFile,
        companyId: previousResults.companyId,
        companyName: previousResults.companyName,
        scrapingLevel,
        retryAttempt: true,
        processedAds: [],
        failedAds: [],
        downloadResults: [],
        summary: {
            totalAdsToRetry: previousResults.failedAds.length,
            successfulDetails: 0,
            stillFailed: 0,
            videoAdsSkipped: 0,
            successfulDownloads: 0,
            failedDownloads: 0
        }
    };
    
    try {
        // Track logo downloads
        const downloadedLogosByCompany = new Set();
        
        // Process each failed ad
        for (let i = 0; i < previousResults.failedAds.length; i++) {
            const failedAd = previousResults.failedAds[i];
            
            console.log(`\n[${i + 1}/${previousResults.failedAds.length}] Retrying Ad ID: ${failedAd.adId}`);
            console.log(`  Previous failure reason: ${failedAd.reason}`);
            
            try {
                const adDetails = await scraper.level2ScrapingWithLynx(failedAd.adUrl);
                
                if (adDetails && adDetails.headline) {
                    console.log(`  ✓ Success! Headline: ${adDetails.headline.substring(0, 60)}...`);
                    console.log(`  Company: ${adDetails.company || 'N/A'}`)
                    console.log(`  Ad Format: ${adDetails.adFormat || 'N/A'}`);
                    
                    // Check if video ad
                    const isVideoAd = adDetails.adFormat && adDetails.adFormat.toLowerCase().includes('video');
                    
                    if (isVideoAd) {
                        console.log(`  SKIPPED: Video ad (no static image)`);
                        results.summary.videoAdsSkipped++;
                    } else {
                        results.processedAds.push(adDetails);
                        results.summary.successfulDetails++;
                        
                        // Download images if Level 3
                        if (scrapingLevel >= 3 && adDetails.imageUrl) {
                            console.log(`  Downloading image...`);
                            try {
                                const downloadResults = await scraper.imageDownloader.downloadAdImages(adDetails);
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
                        
                        // Download logo if needed
                        if (scrapingLevel >= 3 && adDetails.logoUrl && companyId && !downloadedLogosByCompany.has(companyId)) {
                            console.log(`  Downloading company logo...`);
                            try {
                                const ext = scraper.imageDownloader.getFileExtension(adDetails.logoUrl);
                                const filename = `${companyId}_logo${ext}`;
                                await scraper.imageDownloader.downloadImage(adDetails.logoUrl, filename);
                                downloadedLogosByCompany.add(companyId);
                                console.log(`  Logo downloaded: ${filename}`);
                            } catch (error) {
                                console.error(`  Failed to download logo: ${error.message}`);
                            }
                        }
                    }
                } else {
                    console.log(`  ✗ Still no headline found`);
                    results.summary.stillFailed++;
                    results.failedAds.push({
                        adId: failedAd.adId,
                        adUrl: failedAd.adUrl,
                        reason: 'No headline found (retry attempt)'
                    });
                }
            } catch (error) {
                console.error(`  ✗ ERROR: ${error.message}`);
                results.summary.stillFailed++;
                results.failedAds.push({
                    adId: failedAd.adId,
                    adUrl: failedAd.adUrl,
                    reason: `${error.message} (retry attempt)`
                });
            }
            
            // Add delay between retries
            if (i < previousResults.failedAds.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        
        results.endTime = new Date().toISOString();
        
        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('RETRY SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total ads retried: ${results.summary.totalAdsToRetry}`);
        console.log(`Successfully recovered: ${results.summary.successfulDetails}`);
        console.log(`Video ads skipped: ${results.summary.videoAdsSkipped}`);
        console.log(`Still failed: ${results.summary.stillFailed}`);
        
        if (scrapingLevel >= 3) {
            console.log(`Successful downloads: ${results.summary.successfulDownloads}`);
            console.log(`Failed downloads: ${results.summary.failedDownloads}`);
        }
        console.log('='.repeat(60));
        
        // Save retry results
        const timestamp = Date.now();
        const retryFilename = `scraping_results_RETRY_${timestamp}.json`;
        const retryFilepath = path.join(outputDir, retryFilename);
        
        fs.writeFileSync(retryFilepath, JSON.stringify(results, null, 2));
        console.log(`\nRetry results saved to: ${retryFilepath}`);
        
        if (results.summary.successfulDetails > 0) {
            console.log(`\nRecovered ${results.summary.successfulDetails} ads!`);
        }
        
        if (results.summary.stillFailed > 0) {
            console.log(`\n${results.summary.stillFailed} ads still failed. Check the retry results for details.`);
        }
        
    } finally {
        await scraper.closeBrowser();
    }
}

// Main execution
if (require.main === module) {
    retryFailedAds()
        .then(() => {
            console.log('\nRetry completed!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('Retry failed:', error.message);
            process.exit(1);
        });
}

module.exports = retryFailedAds;
