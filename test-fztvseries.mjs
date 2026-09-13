import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const TIMEOUT = 120_000;

function detectFileType(buf) {
  if (!buf || buf.length < 4) return 'unknown';
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'ZIP';
  if (buf[0] === 0x1f && buf[1] === 0x8b) return 'GZIP';
  if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) return 'RAR';
  if (buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc && buf[3] === 0xaf) return '7Z';
  const str = buf.toString('utf8', 0, Math.min(buf.length, 256)).toLowerCase();
  if (str.includes('<!doctype') || str.includes('<html')) return 'HTML';
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'MP4/MOV';
  return 'unknown';
}

function h(url) { try { return new URL(url).hostname; } catch { return '???'; } }

(async () => {
  console.log('=== FZTVSERIES.NG FULL DOWNLOAD CHAIN ===\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  let responses = [];
  page.on('response', (r) => {
    responses.push({ url: r.url(), status: r.status(), ct: r.headers()['content-type'] || '' });
  });

  // ==========================================
  // STEP 1: fztvseries.ng
  // ==========================================
  const indexUrl = 'https://fztvseries.ng/my-hero-academia-vigilantes-s02-anime-series/';
  console.log(`[STEP 1] Index: ${indexUrl}`);
  await page.goto(indexUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(3000);

  const ep1 = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a')).find(a =>
      a.textContent.trim() === 'Episode 1' && (a.className||'').includes('shortc-button')
    );
    return a ? a.href : null;
  });
  console.log(`  Episode 1 -> ${ep1}\n`);

  // ==========================================
  // STEP 2: loadedfiles.org → loadedfiles.net
  // ==========================================
  console.log('[STEP 2] Navigating to host...');
  await page.goto(ep1, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(3000);
  const url1 = page.url();
  console.log(`  Landed: ${url1}\n`);

  // ==========================================
  // STEP 3: PT URL
  // ==========================================
  console.log('[STEP 3] Extracting PT URL...');
  const ptUrl = await page.evaluate(() => {
    const m = document.documentElement.innerHTML.match(/https?:\/\/loadedfiles\.net\/[a-f0-9]+\?pt=[^\s"'<>]+/);
    return m ? m[0] : null;
  });
  console.log(`  PT URL: ${ptUrl}\n`);

  // ==========================================
  // STEP 4: Navigate to PT page
  // ==========================================
  console.log('[STEP 4] Navigating to PT page...');
  responses = [];
  await page.goto(ptUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(3000);
  const url2 = page.url();
  console.log(`  Landed: ${url2}`);

  const ptPageText = await page.evaluate(() => document.body?.innerText?.substring(0, 1000) || '');
  console.log(`  Page text: ${ptPageText.replace(/\n/g, ' | ').substring(0, 500)}\n`);

  // ==========================================
  // STEP 5: Click Download button
  // ==========================================
  console.log('[STEP 5] Clicking Download button...');
  responses = [];
  let download = null;
  try {
    download = await Promise.race([
      page.waitForEvent('download', { timeout: 30000 }),
      (async () => {
        await page.waitForTimeout(30000);
        return null;
      })(),
    ]);
  } catch {}

  // Actually click the button
  const dlResult = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }).catch(() => null),
    page.click('#downloadButton', { timeout: 10000 }).catch(e => {
      console.log(`  Click error: ${e.message}`);
      return null;
    }),
  ]);
  download = dlResult[0];

  await page.waitForTimeout(5000);

  const url3 = page.url();
  console.log(`  After click URL: ${url3}`);

  if (download) {
    console.log('\n  ===== DOWNLOAD CAPTURED =====');
    console.log(`  Filename: ${download.suggestedFilename()}`);
    console.log(`  Download URL: ${download.url()}`);

    const dlPath = path.join(process.cwd(), 'fztvseries-ep1-download.bin');
    await download.saveAs(dlPath);
    const stat = fs.statSync(dlPath);
    const buf = fs.readFileSync(dlPath);
    console.log(`  Saved: ${dlPath}`);
    console.log(`  Size: ${stat.size} bytes (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`  Magic bytes: ${detectFileType(buf)}`);
    console.log(`  First 64 bytes hex: ${buf.subarray(0, 64).toString('hex')}`);

    // Check if it's HTML (redirect page) or actual binary
    if (detectFileType(buf) === 'HTML') {
      console.log('\n  Downloaded file is HTML - checking for CDN URL...');
      const html = buf.toString('utf8');
      const cdnUrls = html.match(/https?:\/\/[^\s"'<>]+/g) || [];
      const relevant = cdnUrls.filter(u => /cdn|video|stream|storage|\.mp4|\.mkv|\.zip|file/i.test(u));
      console.log(`  Relevant URLs in HTML: ${relevant.length}`);
      [...new Set(relevant)].forEach(u => console.log(`    ${u}`));
    }
  } else {
    console.log('  No download event fired.');

    // Check if a new page/tab opened
    const allPages = context.pages();
    console.log(`  Open pages: ${allPages.length}`);
    for (const p of allPages) {
      console.log(`    ${p.url()}`);
    }

    // Check responses
    const extResponses = responses.filter(r => {
      const host = h(r.url);
      return !host.includes('loadedfiles') && !host.includes('google') && !host.includes('cloudflare') && !host.includes('adskeeper') && r.status >= 200;
    });
    console.log(`\n  External responses: ${extResponses.length}`);
    extResponses.forEach((r, i) => console.log(`    [${i}] ${r.status} ${h(r.url)} ${r.ct.substring(0, 40)} ${r.url.substring(0, 150)}`));

    // Try clicking again with force
    console.log('\n  Retrying click with force...');
    const retryResult = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }).catch(() => null),
      page.locator('#downloadButton').click({ force: true }).catch(e => e.message),
    ]);
    download = retryResult[0];
    await page.waitForTimeout(5000);

    if (download) {
      console.log('  ===== DOWNLOAD CAPTURED (retry) =====');
      console.log(`  Filename: ${download.suggestedFilename()}`);
      console.log(`  Download URL: ${download.url()}`);

      const dlPath = path.join(process.cwd(), 'fztvseries-ep1-download.bin');
      await download.saveAs(dlPath);
      const stat = fs.statSync(dlPath);
      const buf = fs.readFileSync(dlPath);
      console.log(`  Saved: ${dlPath}`);
      console.log(`  Size: ${stat.size} bytes (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
      console.log(`  Magic bytes: ${detectFileType(buf)}`);
      console.log(`  First 64 bytes hex: ${buf.subarray(0, 64).toString('hex')}`);
    } else {
      console.log('  Still no download event.');

      // Check if page changed to show a CDN URL or video
      const newUrl = page.url();
      console.log(`  Current URL: ${newUrl}`);

      // Look for video/source/embed
      const media = await page.evaluate(() => {
        const els = [];
        document.querySelectorAll('video, video source, iframe[src], embed[src], object[data]').forEach(el => {
          els.push({ tag: el.tagName, src: el.src || el.getAttribute('src') || el.getAttribute('data') || '' });
        });
        return els;
      });
      console.log(`  Media elements: ${media.length}`);
      media.forEach(m => console.log(`    <${m.tag}> src="${m.src}"`));

      // Search page source for CDN URLs
      const source = await page.evaluate(() => document.documentElement.innerHTML);
      const cdnUrls = source.match(/https?:\/\/[^\s"'<>]*(?:\.mp4|\.mkv|cdn[0-9]|video|stream|storage|\.zip)[^\s"'<>]*/gi) || [];
      const uniqueCdn = [...new Set(cdnUrls)].filter(u => !u.includes('loadedfiles.net/themes') && !u.includes('loadedfiles.net/cache') && !u.includes('google'));
      if (uniqueCdn.length) {
        console.log('\n  CDN-like URLs in page source:');
        uniqueCdn.forEach(u => console.log(`    ${u}`));
      }

      // Dump full page HTML for analysis
      const fullHtml = await page.evaluate(() => document.documentElement.outerHTML);
      // Find the downloadButton onclick handler
      const btnHandler = fullHtml.match(/downloadButton[^}]*}[^}]*}/)?.[0] || '';
      if (btnHandler) {
        console.log(`\n  downloadButton handler: ${btnHandler.substring(0, 500)}`);
      }

      // Find all JS in the page
      const scriptContent = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('script:not([src])')).map(s => s.textContent).join('\n');
      });
      // Look for download-related JS
      const dlScripts = scriptContent.split('\n').filter(l =>
        /download|redirect|window\.location|href\s*=|\.mp4|\.mkv|cdn/i.test(l)
      );
      if (dlScripts.length) {
        console.log('\n  Download-related script lines:');
        dlScripts.forEach(l => console.log(`    ${l.trim().substring(0, 200)}`));
      }
    }
  }

  // ==========================================
  // FINAL SUMMARY
  // ==========================================
  console.log('\n\n========== FULL CHAIN SUMMARY ==========');
  console.log('');
  console.log('CHAIN: fztvseries.ng -> loadedfiles.org -> loadedfiles.net');
  console.log('');
  console.log('1. fztvseries.ng (content index)');
  console.log(`   URL: ${indexUrl}`);
  console.log('   Episode links: <a class="shortc-button small button">');
  console.log('   href: https://loadedfiles.org/<hash>/<filename>.mkv');
  console.log('');
  console.log('2. loadedfiles.org (redirect)');
  console.log('   301 redirects to loadedfiles.net');
  console.log('');
  console.log('3. loadedfiles.net file page (Page 1)');
  console.log(`   URL: ${url1}`);
  console.log('   Shows: filename + file size');
  console.log('   Button: "Proceed To Download Page" (JS-driven)');
  console.log('   No cooldown timer');
  console.log('');
  console.log('4. loadedfiles.net PT page (Page 2)');
  console.log(`   URL: ${url2}`);
  console.log('   Shows: filename + file size');
  console.log('   Button: "Download"');
  console.log('   No cooldown timer');
  console.log('   PT URLs are base64-encoded and token-based');
  console.log('');
  console.log('File: My.Hero.Academia.Vigilantes.S02E01.540p.x265.AAC.[9jaRocks.Com].mkv');
  console.log('Size: ~67.52 MB');
  console.log('Format: MKV (x265/AAC, 540p)');
  console.log('==========================================');

  await browser.close();
  console.log('Done.');
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
