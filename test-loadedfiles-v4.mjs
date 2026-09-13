import { chromium } from 'playwright';
import { writeFileSync, statSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import https from 'https';
import http from 'http';

const LANDING_URL = 'https://loadedfiles.net/fdde7e3ed4e67090/Daemons.of.The.Shadow.Realm.S01E01.540p.x265.AAC.[9jaRocks.Com].mkv';

function downloadUrlToBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadUrlToBuffer(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      console.log(`  HTTP ${res.statusCode} CT=${res.headers['content-type']} CL=${res.headers['content-length']}`);
      console.log(`  CD: ${res.headers['content-disposition'] || 'none'}`);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptDownloads: true,
  });

  let cdnUrl = null;
  let cdnHeaders = null;

  const runFlow = async (epLabel) => {
    const page = await context.newPage();

    page.on('response', async (response) => {
      const ct = response.headers()['content-type'] || '';
      const disposition = response.headers()['content-disposition'] || '';
      if ((ct.includes('video/') || /attachment/i.test(disposition)) && !cdnUrl) {
        cdnUrl = response.url();
        cdnHeaders = response.headers();
        console.log(`*** MEDIA: ct=${ct} cl=${cdnHeaders['content-length']} cd=${disposition.substring(0, 80)}`);
        console.log(`    URL: ${cdnUrl.substring(0, 300)}`);
      }
    });

    // PAGE 1
    console.log(`\n=== ${epLabel} PAGE 1 ===`);
    await page.goto(LANDING_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    console.log(`URL: ${page.url()}`);

    const pt1 = await page.evaluate(() => {
      for (const s of document.querySelectorAll('script')) {
        const m = s.textContent?.match(/downloadUrl\s*=\s*['"]([^'"]+)['"]/);
        if (m) return m[1];
      }
      return null;
    });
    console.log(`pt1: ${pt1?.substring(0, 120)}`);

    // Wait cooldown
    console.log('Waiting 22s cooldown...');
    await page.waitForTimeout(22000);
    await page.evaluate(() => { window.open = () => null; });

    // Navigate directly to pt1 URL (bypasses the evaluate click issue)
    console.log(`\n=== ${epLabel} Navigate to pt1 URL ===`);
    await page.goto(pt1, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    console.log(`URL: ${page.url()}`);

    const pt2 = await page.evaluate(() => {
      for (const s of document.querySelectorAll('script')) {
        const m = s.textContent?.match(/downloadUrl\s*=\s*['"]([^'"]+)['"]/);
        if (m) return m[1];
      }
      return null;
    });
    console.log(`pt2: ${pt2?.substring(0, 120)}`);

    // Wait cooldown on Page 2
    console.log('Waiting 22s cooldown...');
    await page.waitForTimeout(22000);
    await page.evaluate(() => { window.open = () => null; });

    // Click on Page 2 and capture navigation
    console.log(`\n=== ${epLabel} Click Download on Page 2 ===`);

    const downloadPromise = page.waitForEvent('download', { timeout: 60000 }).catch(e => {
      console.log(`Download event: ${e.message.substring(0, 80)}`);
      return null;
    });

    // Use page.evaluate to trigger the click, which will cause window.location.href
    const navPromise = page.waitForNavigation({ timeout: 15000 }).catch(e => {
      console.log(`Navigation: ${e.message.substring(0, 80)}`);
      return null;
    });

    await page.evaluate(() => { document.getElementById('downloadButton')?.click(); });
    console.log('Clicked');

    const nav = await navPromise;
    if (nav) {
      console.log(`Navigation response URL: ${nav.url().substring(0, 200)}`);
      console.log(`Navigation status: ${nav.status()}`);
      console.log(`Navigation CT: ${nav.headers()['content-type']}`);
      console.log(`Navigation CL: ${nav.headers()['content-length']}`);
      console.log(`Navigation CD: ${nav.headers()['content-disposition']}`);
      console.log(`Page URL: ${page.url()}`);

      const ct = nav.headers()['content-type'] || '';
      const cd = nav.headers()['content-disposition'] || '';
      if (ct.includes('video') || ct.includes('octet') || /attachment/i.test(cd)) {
        cdnUrl = nav.url();
        cdnHeaders = nav.headers();
        console.log('*** Navigation response IS the media file ***');
      }
    } else {
      console.log(`No navigation. Page URL: ${page.url()}`);
    }

    const dl = await downloadPromise;
    if (dl) {
      cdnUrl = dl.url();
      console.log(`*** Download event URL: ${cdnUrl.substring(0, 300)} ***`);
    }

    // If we still don't have a CDN URL, try pt2 directly
    if (!cdnUrl && pt2) {
      console.log(`\nTrying pt2 URL directly via context.request...`);
      const resp = await context.request.get(pt2, { timeout: 60000 });
      const h = resp.headers();
      console.log(`Status: ${resp.status()} CT: ${h['content-type']} CL: ${h['content-length']} CD: ${h['content-disposition']}`);
      const ct = h['content-type'] || '';
      if (ct.includes('video') || ct.includes('octet') || /attachment/i.test(h['content-disposition'] || '')) {
        cdnUrl = pt2;
        cdnHeaders = h;
      } else {
        // Maybe there's a pt3?
        const body = (await resp.body()).toString('utf-8');
        const pt3match = body.match(/downloadUrl\s*=\s*['"]([^'"]+)['"]/);
        if (pt3match) {
          console.log(`Found pt3: ${pt3match[1].substring(0, 120)}`);
          const resp3 = await context.request.get(pt3match[1], { timeout: 60000 });
          const h3 = resp3.headers();
          console.log(`pt3 Status: ${resp3.status()} CT: ${h3['content-type']} CL: ${h3['content-length']} CD: ${h3['content-disposition']}`);
          if (h3['content-type']?.includes('video') || /attachment/i.test(h3['content-disposition'] || '')) {
            cdnUrl = pt3match[1];
            cdnHeaders = h3;
          }
        }
      }
    }

    await page.close();
  };

  await runFlow('S01E01');

  if (cdnUrl) {
    console.log(`\n\n=== DOWNLOADING ${cdnUrl.substring(0, 200)} ===`);
    try {
      const buf = await downloadUrlToBuffer(cdnUrl);
      const savePath = 'test-fixtures/downloaded_Daemons_S01E01.mkv';
      writeFileSync(savePath, buf);

      const stat = statSync(savePath);
      console.log(`\n=== VERIFICATION ===`);
      console.log(`File size: ${stat.size} bytes (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
      console.log(`Expected ~63MB: ${stat.size > 50_000_000 && stat.size < 80_000_000 ? 'YES' : 'CHECK'}`);

      const first16 = buf.subarray(0, 16).toString('hex');
      const first64 = buf.subarray(0, 64).toString('hex');
      console.log(`First 16 bytes: ${first16}`);
      console.log(`First 64 bytes: ${first64}`);
      console.log(`MKV magic (1a45dfa3): ${first16.startsWith('1a45dfa3') ? 'YES' : 'NO'}`);
      console.log(`MP4 magic (ftyp): ${first16.substring(4, 8) === '66747970' ? 'YES' : 'NO'}`);

      try {
        const ffOut = execSync(`ffprobe -v error -show_format -show_streams "${savePath}" 2>&1`, { timeout: 30000 }).toString();
        console.log(`\nffprobe:\n${ffOut.substring(0, 3000)}`);
      } catch (e) {
        console.log(`\nffprobe not available`);
      }
    } catch (e) {
      console.log(`Download error: ${e.message}`);
    }
  }

  console.log('\n=== FINAL SUMMARY ===');
  console.log(`CDN URL: ${cdnUrl || 'none'}`);
  console.log(`Content-Type: ${cdnHeaders?.['content-type'] || 'none'}`);
  console.log(`Content-Length: ${cdnHeaders?.['content-length'] || 'none'}`);
  console.log(`Content-Disposition: ${cdnHeaders?.['content-disposition'] || 'none'}`);

  await browser.close();
})();
