const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

class ImageDownloader {
    constructor(downloadDir = './downloaded_images') {
        this.downloadDir = downloadDir;
        this.ensureDownloadDirectory();
    }

    ensureDownloadDirectory() {
        if (!fs.existsSync(this.downloadDir)) {
            fs.mkdirSync(this.downloadDir, { recursive: true });
            console.log(`Created download directory: ${this.downloadDir}`);
        }
    }

    getFileExtension(url) {
        // Extract file extension from URL
        const urlPath = new URL(url).pathname;
        const ext = path.extname(urlPath).toLowerCase();
        
        // Common image extensions
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) {
            return ext;
        }
        
        // Default to .jpg if no extension found
        return '.jpg';
    }

    generateFileName(adId, imageType, url) {
        const extension = this.getFileExtension(url);
        const timestamp = Date.now();
        
        if (adId) {
            return `${adId}_${imageType}_${timestamp}${extension}`;
        } else {
            return `unknown_${imageType}_${timestamp}${extension}`;
        }
    }

    async downloadImage(url, fileName) {
        return new Promise((resolve, reject) => {
            const filePath = path.join(this.downloadDir, fileName);
            const file = fs.createWriteStream(filePath);
            
            // Choose http or https based on URL
            const client = url.startsWith('https:') ? https : http;
            
            console.log(`Downloading: ${fileName}`);
            console.log(`From: ${url}`);
            
            const request = client.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Referer': 'https://www.linkedin.com/'
                }
            }, (response) => {
                // Check if request was successful
                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                    return;
                }

                // Pipe the response to file
                response.pipe(file);

                file.on('finish', () => {
                    file.close();
                    console.log(`✓ Downloaded: ${fileName}`);
                    resolve({
                        fileName,
                        filePath,
                        size: fs.statSync(filePath).size,
                        url
                    });
                });

                file.on('error', (err) => {
                    fs.unlink(filePath, () => {}); // Delete incomplete file
                    reject(err);
                });
            });

            request.on('error', (err) => {
                reject(err);
            });

            // Set timeout
            request.setTimeout(30000, () => {
                request.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }

    async downloadAdImages(adData) {
        const results = [];
        
        console.log(`\nDownloading main ad image for Ad ID: ${adData.adId || 'unknown'}`);
        console.log('='.repeat(50));
        
        // Download main ad image only
        if (adData.imageUrl) {
            try {
                const fileName = this.generateFileName(adData.adId, 'main_image', adData.imageUrl);
                const result = await this.downloadImage(adData.imageUrl, fileName);
                results.push({
                    type: 'main_image',
                    ...result
                });
            } catch (error) {
                console.error(`✗ Failed to download main image: ${error.message}`);
                results.push({
                    type: 'main_image',
                    error: error.message,
                    url: adData.imageUrl
                });
            }
        } else {
            console.log('No main image URL found');
        }

        return results;
    }

    async downloadMultipleAds(adsData) {
        const allResults = [];
        
        console.log(`Starting bulk download for ${adsData.length} ads...`);
        
        for (let i = 0; i < adsData.length; i++) {
            const adData = adsData[i];
            console.log(`\n[${i + 1}/${adsData.length}] Processing ad: ${adData.adId || 'unknown'}`);
            
            try {
                const results = await this.downloadAdImages(adData);
                allResults.push({
                    adId: adData.adId,
                    results
                });
                
                // Add delay between downloads to be respectful
                if (i < adsData.length - 1) {
                    console.log('Waiting 2 seconds before next download...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } catch (error) {
                console.error(`Error processing ad ${adData.adId}: ${error.message}`);
                allResults.push({
                    adId: adData.adId,
                    error: error.message
                });
            }
        }
        
        return allResults;
    }

    generateDownloadReport(results) {
        const report = {
            timestamp: new Date().toISOString(),
            summary: {
                totalAds: results.length,
                successfulDownloads: 0,
                failedDownloads: 0,
                totalFiles: 0,
                totalSize: 0
            },
            details: results
        };

        results.forEach(adResult => {
            if (adResult.results) {
                adResult.results.forEach(imageResult => {
                    if (imageResult.error) {
                        report.summary.failedDownloads++;
                    } else {
                        report.summary.successfulDownloads++;
                        report.summary.totalFiles++;
                        report.summary.totalSize += imageResult.size || 0;
                    }
                });
            }
        });

        // Save report to file
        const reportPath = path.join(this.downloadDir, `download_report_${Date.now()}.json`);
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        
        console.log('\n' + '='.repeat(60));
        console.log('DOWNLOAD REPORT');
        console.log('='.repeat(60));
        console.log(`Total ads processed: ${report.summary.totalAds}`);
        console.log(`Successful downloads: ${report.summary.successfulDownloads}`);
        console.log(`Failed downloads: ${report.summary.failedDownloads}`);
        console.log(`Total files downloaded: ${report.summary.totalFiles}`);
        console.log(`Total size: ${(report.summary.totalSize / 1024 / 1024).toFixed(2)} MB`);
        console.log(`Report saved to: ${reportPath}`);
        console.log('='.repeat(60));

        return report;
    }
}

// Test with sample data from level 2 scraper
const sampleAdData = {
    adId: '878430633',
    headline: 'IT Leaders: Choose ERP with Data, Not Promises',
    company: 'Priority Software',
    imageUrl: 'https://media.licdn.com/dms/image/v2/D4D10AQEohKf0JouisQ/image-shrink_1280/B4DZk6RWkBJEAQ-/0/1757619252196/12001200_2png?e=2147483647&v=beta&t=jpu1UMiTKNd_rJQVfzwsl_fkfKCTglmZZ8kH1-bbk1E'
};

async function testImageDownloader() {
    const downloader = new ImageDownloader();
    
    try {
        console.log('Testing Image Downloader with sample ad data...');
        
        const results = await downloader.downloadAdImages(sampleAdData);
        const report = downloader.generateDownloadReport([{ adId: sampleAdData.adId, results }]);
        
        console.log('\nImage downloader test completed successfully!');
        
    } catch (error) {
        console.error('Image downloader test failed:', error);
        process.exit(1);
    }
}

// Export the class for use in other scripts
module.exports = ImageDownloader;

// Run test if this script is executed directly
if (require.main === module) {
    testImageDownloader();
}