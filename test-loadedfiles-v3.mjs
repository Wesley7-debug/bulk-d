import { chromium } from 'playwright';
import { writeFileSync, statSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import https from 'https';
import http from 'http';

const LANDING_URL = 'https://loadedfiles.net/fdde7e3ed4e67090/Daemons.of.The.Shadow.Realm.S01E01.540p.x265.AAC.[9jaRocks.Com].mkv';

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      console.log(`  HTTP ${res.statusCode} CT=${res.headers['content-type']} CL=${res.headers['content-length']}`);
      console.log(`  CD: ${res.headers['content-disposition'] || 'none'}`);
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        writeFileSync(dest, buf);
        resolve(buf);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptDownloads: true,
  });
  const page = await context.newPage();

  let mediaResponseUrl = null;
  let mediaResponseHeaders = null;
  page.on('response', async (response) => {
    const ct = response.headers()['content-type'] || '';
    const disposition = response.headers()['content-disposition'] || '';
    if ((ct.includes('video/') || ct.includes('audio/') || ct.includes('octet') || ct.includes('x-matroska') || /attachment/i.test(disposition)) && !mediaResponseUrl) {
      mediaResponseUrl = response.url();
      mediaResponseHeaders = response.headers();
      console.log(`*** MEDIA RESPONSE CAPTURED ***`);
      console.log(`  URL: ${mediaResponseUrl.substring(0, 300)}`);
      console.log(`  CT: ${mediaResponseHeaders['content-type']}`);
      console.log(`  CL: ${mediaResponseHeaders['content-length']}`);
      console.log(`  CD: ${mediaResponseHeaders['content-disposition']}`);
    }
  });

  // ===== PAGE 1 =====
  console.log('=== PAGE 1: Loading landing page ===');
  await page.goto(LANDING_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log(`URL: ${page.url()}`);

  console.log('Waiting 22s for Page 1 cooldown...');
  await page.waitForTimeout(22000);
  await page.evaluate(() => { window.open = () => null; });

  // ===== PAGE 2 =====
  console.log('\n=== PAGE 2: Click "Proceed" ===');
  await page.evaluate(() => { document.getElementById('downloadButton')?.click(); });
  await page.waitForTimeout(5000);
  console.log(`URL: ${page.url()}`);

  console.log('Waiting 22s for Page 2 cooldown...');
  await page.waitForTimeout(22000);
  await page.evaluate(() => { window.open = () => null; });

  // ===== PAGE 3 =====
  console.log('\n=== PAGE 3: Click "Download" and capture CDN URL ===');
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 }).catch(e => {
    console.log(`Download event: ${e.message.substring(0, 80)}`);
    return null;
  });

  await page.evaluate(() => { document.getElementById('downloadButton')?.click(); });
  console.log('Clicked Download on Page 2');

  const dl = await downloadPromise;
  let cdnUrl = null;

  if (dl) {
    cdnUrl = dl.url();
    console.log(`\n*** Download event URL: ${cdnUrl.substring(0, 300)} ***`);
    console.log(`Suggested filename: ${dl.suggestedFilename()}`);
    // Don't use saveAs - use direct HTTP instead (much faster)
  } else if (mediaResponseUrl) {
    cdnUrl = mediaResponseUrl;
    console.log(`\nMedia URL from response listener: ${cdnUrl.substring(0, 300)}`);
  }

  if (cdnUrl) {
    const savePath = 'test-fixtures/downloaded_Daemons_S01E01.mkv';
    console.log(`\n=== DOWNLOADING via direct HTTP ===`);
    console.log(`URL: ${cdnUrl.substring(0, 200)}...`);

    try {
      const buf = await downloadFile(cdnUrl, savePath);
      const stat = statSync(savePath);

      console.log(`\n=== VERIFICATION ===`);
      console.log(`File size: ${stat.size} bytes (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
      console.log(`Expected ~63MB (66858259): ${stat.size > 50_000_000 && stat.size < 80_000_000 ? 'YES' : 'CHECK'}`);

      const first16 = buf.subarray(0, 16).toString('hex');
      const first64 = buf.subarray(0, 64).toString('hex');
      console.log(`\nFirst 16 bytes (hex): ${first16}`);
      console.log(`First 64 bytes (hex): ${first64}`);
      console.log(`MKV magic (1a45dfa3): ${first16.startsWith('1a45dfa3') ? 'YES' : 'NO'}`);
      console.log(`MP4 magic (ftyp):     ${first16.substring(4, 8) === '66747970' ? 'YES' : 'NO'}`);

      try {
        const ffOut = execSync(`ffprobe -v error -show_format -show_streams "${savePath}" 2>&1`, { timeout: 30000 }).toString();
        console.log(`\n=== ffprobe output ===`);
        console.log(ffOut.substring(0, 3000));
      } catch (e) {
        console.log(`\nffprobe not available`);
      }
    } catch (e) {
      console.log(`Download error: ${e.message}`);
    }
  }

  console.log('\n=== FINAL SUMMARY ===');
  console.log(`CDN URL: ${cdnUrl || 'none'}`);
  console.log(`Content-Type: ${mediaResponseHeaders?.['content-type'] || 'none'}`);
  console.log(`Content-Length: ${mediaResponseHeaders?.['content-length'] || 'none'}`);
  console.log(`Content-Disposition: ${mediaResponseHeaders?.['content-disposition'] || 'none'}`);

  await browser.close();
})();
