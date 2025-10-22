# LinlinScrappy

A robust LinkedIn Ad Library scraper that extracts ad details, downloads images and company logos while bypassing anti-bot protections.

## Features

- **3-Level Scraping Pipeline**
  - Level 1: Extract ad URLs from search results
  - Level 2: Scrape detailed ad information (headline, company, description, CTA, etc.)
  - Level 3: Download ad images and company logos

- **Anti-Detection**
  - Browserless.io proxy with residential IPs
  - Lynx CLI for HTML parsing (bypasses JavaScript detection)
  - Realistic headers and request delays

- **Smart Filtering**
  - Automatically detects and skips video ads
  - Downloads company logo only once per company
  - Deduplicates ads by ID

- **Organized Output**
  - Company-based directories with timestamps
  - Comprehensive JSON results with metadata
  - Separate files for ad images and logos

## Requirements

- Node.js 16+
- Lynx (text-based browser)
- Browserless.io API key

### Install Lynx

**macOS:**
```bash
brew install lynx
```

**Ubuntu/Debian:**
```bash
sudo apt-get install lynx
```

## Installation

```bash
npm install
```

## Configuration

Set your Browserless API key:

```bash
export BROWSERLESS_API_KEY="your_api_key_here"
```

Or create a `.env` file:
```
BROWSERLESS_API_KEY=your_api_key_here
```

## Usage

### Basic Usage

```bash
node main-scraper-lynx.js "<linkedin_ad_library_url>" [maxAds] [scrapingLevel]
```

### Examples

**Scrape 10 ads with full pipeline (images + logos):**
```bash
node main-scraper-lynx.js "https://www.linkedin.com/ad-library/search?companyIds=89771&dateOption=last-30-days" 10 3
```

**Extract 50 ad details without downloading images:**
```bash
node main-scraper-lynx.js "https://www.linkedin.com/ad-library/search?companyIds=89771" 50 2
```

**Just get ad URLs:**
```bash
node main-scraper-lynx.js "https://www.linkedin.com/ad-library/search?companyIds=89771" 100 1
```

### Scraping Levels

- **Level 1** - Find ad URLs only
- **Level 2** - Level 1 + Extract ad details
- **Level 3** - Level 1 + Level 2 + Download images (default)

## Output Structure

```
priority_software_20251022/
├── 89771_logo.jpg                              # Company logo
├── 901310383_main_image_1761151474402.jpg     # Ad images
├── 878410933_main_image_1761151477960.jpg
└── scraping_results_lynx_1761151480917.json   # Metadata
```

### Results JSON Structure

```json
{
  "startTime": "2025-10-22T14:44:00.000Z",
  "endTime": "2025-10-22T14:44:33.000Z",
  "duration": 33000,
  "targetUrl": "https://www.linkedin.com/ad-library/search?companyIds=89771",
  "companyId": "89771",
  "scrapingLevel": 3,
  "processedAds": [
    {
      "adId": "901310383",
      "sourceUrl": "https://www.linkedin.com/ad-library/detail/901310383",
      "headline": "See Which ERP Performs Best for SMBs",
      "company": "Priority Software",
      "imageUrl": "https://media.licdn.com/...",
      "imageAlt": "See Which ERP Performs Best for SMBs",
      "targetUrl": "https://www.priority-software.com/...",
      "description": "Most IT leaders settle for vendor-led evaluations...",
      "logoUrl": "https://media.licdn.com/...",
      "adFormat": "Single Image Ad",
      "cta": null
    }
  ],
  "summary": {
    "totalAdsFound": 5,
    "totalAdsProcessed": 5,
    "successfulDetails": 4,
    "videoAdsSkipped": 1,
    "failedDetails": 0,
    "successfulDownloads": 4,
    "failedDownloads": 0
  }
}
```

## Architecture

### Main Components

- **main-scraper-lynx.js** - Primary scraper with 3-level pipeline
- **image-downloader.js** - Handles image/logo downloads
- **level1-only.js** - Utility for quick URL extraction

### Scraping Flow

```
1. Browserless Proxy
   └─> Navigate to LinkedIn Ad Library

2. Level 1: URL Collection
   └─> Scroll page to load ads
   └─> Extract ad detail URLs
   └─> Filter duplicates

3. Level 2: Detail Extraction (Lynx)
   └─> For each ad URL:
       ├─> Fetch HTML via Lynx
       ├─> Extract: headline, company, description, CTA, format
       └─> Skip if Video Ad

4. Level 3: Asset Download
   └─> Download ad images
   └─> Download company logo (once per company)
```

## API Keys

### Browserless.io

Get your API key at [browserless.io](https://www.browserless.io/)

Free tier includes:
- 6 hours/month
- Residential proxies
- Chrome automation

## Rate Limiting

- Default delay between ads: 300ms
- Image download timeout: 30s
- Respects LinkedIn's rate limits

## Limitations

- Video ads are detected and skipped (no static images)
- Requires active Browserless.io session
- LinkedIn may block excessive scraping

## Troubleshooting

**Error: BROWSERLESS_API_KEY not set**
```bash
export BROWSERLESS_API_KEY="your_key"
```

**Error: lynx command not found**
```bash
brew install lynx  # macOS
```

**Error: Failed to rename directory**
- Directory already exists from previous run
- Script will reuse existing directory

## Code Review

See [CODE_REVIEW.md](./CODE_REVIEW.md) for:
- Architecture analysis
- Performance optimizations
- Security considerations
- Recommended improvements

## License

MIT

## Contributing

Pull requests welcome! Please see CODE_REVIEW.md for optimization opportunities.

## Disclaimer

This tool is for educational purposes. Ensure compliance with LinkedIn's Terms of Service and robots.txt. Use responsibly and respect rate limits.
