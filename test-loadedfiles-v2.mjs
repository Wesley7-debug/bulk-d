import { chromium } from 'playwright';
import { writeFileSync, statSync, readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const LANDING_URL = 'https://loadedfiles.net/fdde7e3ed4e67090/Daemons.of.The.Shadow.Realm.S01E01.540p.x265.AAC.[9jaRocks.Com].mkv';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptDownloads: true,
  });
  const page = await context.newPage();

  let mediaResponseHeaders = null;
  let mediaUrl = null;
  page.on('response', async (response) => {
    const ct = response.headers()['content-type'] || '';
    const disposition = response.headers()['content-disposition'] || '';
    if (ct.includes('video/') || ct.includes('audio/') || ct.includes('application/octet-stream')
        || ct.includes('application/x-matroska') || /attachment/i.test(disposition)) {
      mediaUrl = response.url();
      mediaResponseHeaders = response.headers();
      console.log(`*** MEDIA: ct=${ct} cl=${response.headers()['content-length']} disp=${disposition.substring(0, 100)}`);
      console.log(`    URL: ${response.url().substring(0, 300)}`);
    }
  });

  // ===== PHASE 1: Landing page =====
  console.log('=== PHASE 1: Load landing page ===');
  await page.goto(LANDING_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const ptUrl1 = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const text = s.textContent;
      if (text && text.includes('downloadUrl')) {
        const match = text.match(/downloadUrl\s*=\s*['"]([^'"]+)['"]/);
        if (match) return match[1];
      }
    }
    return null;
  });
  console.log(`Page 1 pt= URL: ${ptUrl1}`);

  // Wait for cooldown on Page 1
  console.log('Waiting 22s for Page 1 cooldown...');
  await page.waitForTimeout(22000);
  await page.evaluate(() => { window.open = () => null; });

  // ===== PHASE 2: Navigate to pt= page (click via evaluate to trigger window.location.href) =====
  console.log('\n=== PHASE 2: Click "Proceed" on Page 1 ===');
  await page.evaluate(() => {
    const btn = document.getElementById('downloadButton');
    if (btn) btn.click();
  });
  await page.waitForTimeout(5000);
  console.log(`URL: ${page.url()}`);
  console.log(`Title: ${await page.title()}`);

  // Extract pt= URL from Page 2
  const ptUrl2 = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const text = s.textContent;
      if (text && text.includes('downloadUrl')) {
        const match = text.match(/downloadUrl\s*=\s*['"]([^'"]+)['"]/);
        if (match) return match[1];
      }
    }
    return null;
  });
  console.log(`Page 2 pt= URL: ${ptUrl2}`);

  // Wait for cooldown on Page 2
  console.log('Waiting 22s for Page 2 cooldown...');
  await page.waitForTimeout(22000);
  await page.evaluate(() => { window.open = () => null; });

  // ===== PHASE 3: Click "Download" on Page 2 =====
  console.log('\n=== PHASE 3: Click "Download" on Page 2 ===');
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 }).catch(e => {
    console.log(`Download event: ${e.message.substring(0, 100)}`);
    return null;
  });

  await page.evaluate(() => {
    const btn = document.getElementById('downloadButton');
    if (btn) btn.click();
  });
  console.log('Clicked Download on Page 2');

  const dl = await downloadPromise;

  if (dl) {
    const downloadUrl = dl.url();
    const suggestedFilename = dl.suggestedFilename();
    console.log(`\n*** DOWNLOAD EVENT FIRED ***`);
    console.log(`  URL: ${downloadUrl.substring(0, 300)}`);
    console.log(`  Filename: ${suggestedFilename}`);

    const savePath = `test-fixtures/downloaded_${suggestedFilename || 'file.mkv'}`;
    console.log(`  Saving to ${savePath} (may take a while for ~63MB)...`);
    await dl.saveAs(savePath);

    const stat = statSync(savePath);
    console.log(`\n=== VERIFICATION ===`);
    console.log(`File size: ${stat.size} bytes (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

    const buf = readFileSync(savePath);
    const first16 = buf.subarray(0, 16).toString('hex');
    const first64 = buf.subarray(0, 64).toString('hex');
    console.log(`First 16 bytes (hex): ${first16}`);
    console.log(`First 64 bytes (hex): ${first64}`);
    console.log(`MKV magic (1a45dfa3): ${first16.startsWith('1a45dfa3') ? 'YES' : 'NO'}`);
    console.log(`MP4 magic (ftyp): ${first16.substring(4, 8) === '66747970' ? 'YES' : 'NO'}`);
    console.log(`Expected ~63MB: ${stat.size > 50_000_000 && stat.size < 80_000_000 ? 'YES' : 'CHECK SIZE'}`);

    // Response headers from the network listener
    if (mediaResponseHeaders) {
      console.log(`\nResponse headers:`);
      console.log(`  Content-Type: ${mediaResponseHeaders['content-type']}`);
      console.log(`  Content-Length: ${mediaResponseHeaders['content-length']}`);
      console.log(`  Content-Disposition: ${mediaResponseHeaders['content-disposition']}`);
    }

    // ffprobe
    try {
      const ffOut = execSync(`ffprobe -v error -show_format -show_streams "${savePath}" 2>&1`, { timeout: 30000 }).toString();
      console.log(`\nffprobe output:\n${ffOut.substring(0, 3000)}`);
    } catch (e) {
      console.log(`\nffprobe not available or error: ${(e.message || '').substring(0, 200)}`);
    }
  } else {
    console.log('No download event fired.');
    console.log(`Post-click URL: ${page.url()}`);
    if (mediaUrl) {
      console.log(`Media URL captured by response listener: ${mediaUrl}`);
    }
  }

  console.log('\n=== FINAL SUMMARY ===');
  console.log(`Real file CDN URL: ${mediaUrl || dl?.url() || 'none'}`);
  console.log(`Content-Type: ${mediaResponseHeaders?.['content-type'] || 'none'}`);
  console.log(`Content-Length: ${mediaResponseHeaders?.['content-length'] || 'none'}`);
  console.log(`Content-Disposition: ${mediaResponseHeaders?.['content-disposition'] || 'none'}`);

  await browser.close();
})();
