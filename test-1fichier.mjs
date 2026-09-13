import { chromium } from 'playwright';
import https from 'https';
import http from 'http';
import { writeFileSync, statSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const ffprobePath = (() => {
  try { execSync('ffprobe -version', { stdio: 'ignore' }); return 'ffprobe'; } catch {
    const mp = execSync('[System.Environment]::GetEnvironmentVariable("Path","Machine")', { shell: 'powershell', stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    const up = execSync('[System.Environment]::GetEnvironmentVariable("Path","User")', { shell: 'powershell', stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    for (const p of (mp + ';' + up).split(';')) { if (existsSync(p + '/ffprobe.exe')) return p + '/ffprobe.exe'; }
    return null;
  }
})();

function httpGetFollow(url, max = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && max > 0) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) loc = new URL(url).origin + loc;
        res.resume(); httpGetFollow(loc, max - 1).then(resolve).catch(reject); return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
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

  console.log('=== 1fichier.com: iCarly.S01E01 ===');
  await page.goto('https://1fichier.com/?h612zcsmv4t0i3dthq4h', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log(`Title: ${await page.title()}`);

  // Wait for countdown (54s)
  console.log('\nWaiting for countdown...');
  for (let i = 0; i < 35; i++) {
    await page.waitForTimeout(2000);
    const disabled = await page.evaluate(() => document.getElementById('dlw')?.disabled);
    const text = await page.evaluate(() => document.getElementById('dlw')?.textContent?.trim());
    if (i % 5 === 0) console.log(`  ${i * 2}s: ${text?.substring(0, 30)}`);
    if (!disabled) { console.log(`Button enabled after ${i * 2}s`); break; }
  }

  // STEP 1: Click #dlw (form submit - first click)
  console.log('\n=== STEP 1: Click #dlw (form submit) ===');
  const navPromise = page.waitForNavigation({ timeout: 30000 }).catch(e => null);
  await page.evaluate(() => document.getElementById('dlw')?.click());
  await navPromise;
  await page.waitForTimeout(3000);
  console.log(`URL after form submit: ${page.url()}`);

  // Check what the page looks like now
  const btnInfo2 = await page.evaluate(() => {
    const btn = document.getElementById('dlw');
    if (!btn) return { exists: false };
    return {
      exists: true,
      text: btn.textContent?.trim(),
      disabled: btn.disabled,
      tag: btn.tagName,
    };
  });
  console.log(`Button after submit: ${JSON.stringify(btnInfo2)}`);

  // Check if there's a direct download link now
  const directLink = await page.evaluate(() => {
    // Check for any link with the actual file
    const links = document.querySelectorAll('a[href]');
    for (const a of links) {
      const href = a.href;
      const text = a.textContent?.trim();
      if (/download|start|click here/i.test(text) && href.startsWith('http') && !href.includes('javascript:')) {
        return { href, text };
      }
    }
    // Check for form with download action
    const forms = document.querySelectorAll('form');
    for (const f of forms) {
      if (f.action?.includes('download') || f.id === 'dlf') {
        return { formAction: f.action, formId: f.id, method: f.method };
      }
    }
    return null;
  });
  console.log(`Direct link/form: ${JSON.stringify(directLink)}`);

  // Check full page content
  const bodyText = await page.evaluate(() => document.body?.textContent?.replace(/\s+/g, ' ')?.substring(0, 1000));
  console.log(`Body text: ${bodyText?.substring(0, 500)}`);

  // Wait for countdown again if present
  console.log('\n=== STEP 2: Wait for second countdown ===');
  for (let i = 0; i < 35; i++) {
    await page.waitForTimeout(2000);
    const disabled = await page.evaluate(() => document.getElementById('dlw')?.disabled);
    const text = await page.evaluate(() => document.getElementById('dlw')?.textContent?.trim());
    if (i % 5 === 0) console.log(`  ${i * 2}s: disabled=${disabled} text="${text?.substring(0, 40)}"`);
    if (disabled === false || disabled === undefined) {
      console.log(`Button enabled after ${i * 2}s`);
      break;
    }
  }

  // STEP 3: Click #dlw again (should trigger actual download)
  console.log('\n=== STEP 3: Click #dlw again ===');
  const dlPromise = page.waitForEvent('download', { timeout: 60000 }).catch(e => {
    console.log(`Download: ${e.message.substring(0, 80)}`);
    return null;
  });
  const navPromise2 = page.waitForNavigation({ timeout: 15000 }).catch(e => null);

  await page.evaluate(() => document.getElementById('dlw')?.click());
  console.log('Clicked');

  const dl = await dlPromise;
  const nav2 = await navPromise2;

  if (dl) {
    console.log(`\n*** DOWNLOAD EVENT ***`);
    console.log(`  URL: ${dl.url().substring(0, 300)}`);
    console.log(`  Filename: ${dl.suggestedFilename()}`);
    const resp = await httpGetFollow(dl.url());
    console.log(`  HTTP ${resp.status} CT=${resp.headers['content-type']} CL=${resp.headers['content-length']}`);
    const ct = resp.headers['content-type'] || '';
    if (ct.includes('video') || ct.includes('octet') || /attachment/i.test(resp.headers['content-disposition'] || '')) {
      const f16 = resp.body.subarray(0, 16).toString('hex');
      console.log(`  Size: ${resp.body.length} (${(resp.body.length / 1024 / 1024).toFixed(2)} MB)`);
      console.log(`  First 16: ${f16}`);
      console.log(`  MKV: ${f16.startsWith('1a45dfa3') ? 'YES' : 'NO'}`);
      console.log(`  MP4: ${f16.substring(4, 8) === '66747970' ? 'YES' : 'NO'}`);
      const savePath = 'test-fixtures/downloaded_1fichier.mkv';
      writeFileSync(savePath, resp.body);
      console.log(`  Saved: ${savePath}`);
      if (ffprobePath) {
        try {
          const ff = execSync(`"${ffprobePath}" -v error -show_format -show_streams "${savePath}" 2>&1`, { timeout: 30000 }).toString();
          console.log(`\nffprobe:\n${ff.substring(0, 2000)}`);
        } catch { console.log('ffprobe error'); }
      }
    }
  } else {
    console.log('No download event');
    if (nav2) {
      console.log(`Nav: ${nav2.url().substring(0, 200)} CT=${nav2.headers()['content-type']}`);
    }
    console.log(`Page URL: ${page.url()}`);
    // Try context.request
    const finalUrl = page.url();
    console.log('\nTrying context.request.get...');
    const resp = await context.request.get(finalUrl, { timeout: 60000 });
    const h = resp.headers();
    console.log(`Status: ${resp.status()} CT: ${h['content-type']} CL: ${h['content-length']} CD: ${h['content-disposition']}`);
  }

  await browser.close();
})();
