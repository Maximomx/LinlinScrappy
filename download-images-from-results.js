const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

async function downloadImage(url, filename) {
    return new Promise((resolve, reject) => {
        const filePath = path.join('./downloaded_ads', filename);
        
        // Ensure directory exists
        if (!fs.existsSync('./downloaded_ads')) {
            fs.mkdirSync('./downloaded_ads', { recursive: true });
        }
        
        const file = fs.createWriteStream(filePath);
        
        console.log(`Downloading: ${filename}`);
        console.log(`From: ${url}`);
        
        const client = url.startsWith('https:') ? https : http;
        
        const request = client.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        }, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                return;
            }
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                const size = fs.statSync(filePath).size;
                console.log(`Downloaded: ${filename} (${(size / 1024).toFixed(2)} KB)\n`);
                resolve({ filename, filePath, size });
            });
            
            file.on('error', (err) => {
                fs.unlink(filePath, () => {});
                reject(err);
            });
        });
        
        request.on('error', (err) => {
            reject(err);
        });
        
        request.setTimeout(30000, () => {
            request.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

async function downloadFromResults(resultsFile, maxImages = null) {
    // Check if file exists
    if (!fs.existsSync(resultsFile)) {
        console.error(`File not found: ${resultsFile}`);
        process.exit(1);
    }
    
    // Read results file
    const results = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));
    
    console.log(`Processing ${resultsFile}`);
    console.log(`Company ID: ${results.companyId}`);
    console.log(`Total ads: ${results.processedAds.length}`);
    
    // Use all images if maxImages is null
    const imagesToDownload = maxImages ? Math.min(maxImages, results.processedAds.length) : results.processedAds.length;
    console.log(`Downloading ${imagesToDownload} images\n`);
    console.log('='.repeat(80));
    
    let downloaded = 0;
    let failed = 0;
    
    for (let i = 0; i < imagesToDownload; i++) {
        const ad = results.processedAds[i];
        
        if (!ad.imageUrl) {
            console.log(`[${i + 1}] Ad ID: ${ad.adId} - No image URL\n`);
            failed++;
            continue;
        }
        
        try {
            // Extract file extension from URL
            const urlPath = new URL(ad.imageUrl).pathname;
            let ext = path.extname(urlPath).toLowerCase();
            
            // Default to .jpg if no extension
            if (!ext || ext === '.png?') {
                ext = '.jpg';
            }
            
            // Create filename with ad ID
            const filename = `${ad.adId}${ext}`;
            
            console.log(`[${i + 1}] Ad ID: ${ad.adId}`);
            await downloadImage(ad.imageUrl, filename);
            downloaded++;
            
        } catch (error) {
            console.error(`Failed: ${error.message}\n`);
            failed++;
        }
    }
    
    console.log('='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`Successfully downloaded: ${downloaded}`);
    console.log(`Failed: ${failed}`);
    console.log(`Images saved to: ./downloaded_ads/`);
}

// Main
async function main() {
    const resultsFile = process.argv[2];
    const maxImages = process.argv[3] ? parseInt(process.argv[3]) : null;
    
    if (!resultsFile) {
        console.error('Usage: node download-images-from-results.js <results-json-file> [maxImages]');
        console.log('Example: node download-images-from-results.js scraping_results_lynx_1761143088601.json 5');
        process.exit(1);
    }
    
    try {
        await downloadFromResults(resultsFile, maxImages);
        console.log('\nImage download completed!');
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { downloadFromResults, downloadImage };
