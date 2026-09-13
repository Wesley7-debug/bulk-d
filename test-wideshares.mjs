import { chromium } from 'playwright';
import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from 'fs';

const URL = 'https://wideshares.org/download/8b151ba28b4b';
const FIXTURES = 'test-fixtures';

if (!existsSync(FIXTURES)) mkdirSync(FIXTURES, { recursive: true });

const summary = {
  staticWorked: false,
  headlessNeeded: false,
  downloadEventVsNavigation: '',
  hops: 0,
  interstitial: false,
  finalContentType: '',
  magicConfirmed: '',
  ffprobeResult: ''
};

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const responses = [];

  page.on('response', async (resp) => {
    const info = {
      url: resp.url(),
      status: resp.status(),
      contentType: resp.headers()['content-type'] || '',
      contentLength: resp.headers()['content-length'] || '',
      contentDisposition: resp.headers()['content-disposition'] || ''
    };
    responses.push(info);
  });

  console.log(`[NAV] Navigating to ${URL}`);
  try {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    console.log(`[NAV] networkidle timeout, trying load...`);
    try {
      await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
    } catch (e2) {
      console.log(`[NAV] load timeout: ${e2.message}`);
    }
  }

  const hops = responses.filter(r => r.status >= 300 && r.status < 400);
  summary.hops = hops.length;
  console.log(`[HOPS] ${hops.length} redirect responses detected`);
  hops.forEach((h, i) => console.log(`  hop ${i + 1}: ${h.status} -> ${h.url.substring(0, 150)} CT=${h.contentType}`));

  console.log(`[WAIT] Waiting 3 seconds after page load...`);
  await page.waitForTimeout(3000);

  // Extract script tags with download/button logic
  const scripts = await page.$$eval('script', (els) =>
    els.map(e => e.textContent || '').filter(t =>
      /download|button|click|redirect|media|force/i.test(t)
    )
  );
  console.log(`\n[SCRIPTS] ${scripts.length} script(s) with download/button logic found`);
  scripts.forEach((s, i) => {
    const snippet = s.substring(0, 3000);
    console.log(`  --- Script ${i + 1} (first 3000 chars) ---`);
    console.log(snippet);
  });

  // Extract all links and buttons
  const elements = await page.$$eval('a, button', (els) =>
    els.map(e => ({
      tag: e.tagName,
      text: (e.textContent || '').trim().substring(0, 200),
      href: e.href || e.getAttribute('href') || '',
      id: e.id || '',
      class: e.className || '',
      type: e.type || '',
      disabled: e.disabled || false
    }))
  );
  console.log(`\n[ELEMENTS] ${elements.length} link/button(s) found:`);
  elements.forEach((e, i) => {
    console.log(`  ${i}: <${e.tag}> text="${e.text}" href="${e.href.substring(0, 120)}" id="${e.id}" class="${e.class.substring(0, 80)}" type="${e.type}" disabled=${e.disabled}`);
  });

  // Check for download button candidates
  const downloadCandidates = [];
  const downloadBtn = await page.$('#downloadButton');
  if (downloadBtn) downloadCandidates.push({ selector: '#downloadButton', el: downloadBtn });

  const btns = await page.$$('button');
  for (const b of btns) {
    const txt = (await b.textContent()) || '';
    if (/download/i.test(txt)) {
      downloadCandidates.push({ selector: `button: "${txt.trim().substring(0, 50)}"`, el: b });
      break;
    }
  }

  const anchors = await page.$$('a');
  for (const a of anchors) {
    const txt = (await a.textContent()) || '';
    const href = (await a.getAttribute('href')) || '';
    if (/download|\.mkv|\.mp4|\.avi|\.get/i.test(txt) || /download/i.test(href)) {
      downloadCandidates.push({ selector: `a: href="${href.substring(0, 80)}" text="${txt.trim().substring(0, 50)}"`, el: a });
      break;
    }
  }

  console.log(`\n[DOWNLOAD CANDIDATES] ${downloadCandidates.length} candidate(s) found`);
  downloadCandidates.forEach((c, i) => console.log(`  ${i}: ${c.selector}`));

  const pageUrl = page.url();
  const pageTitle = await page.title();
  console.log(`\n[PAGE] URL: ${pageUrl}`);
  console.log(`[PAGE] Title: ${pageTitle}`);

  // Check for interstitial
  const bodyText = await page.$eval('body', el => el.innerText).catch(() => '');
  const isInterstitial = /captcha|challenge|cloudflare|verif|human|robot|checking your browser/i.test(bodyText) &&
    !/download/i.test(bodyText.substring(0, 500));
  summary.interstitial = isInterstitial;
  console.log(`[INTERSTITIAL] ${isInterstitial}`);
  if (isInterstitial) console.log(`[BODY TEXT (first 1000)] ${bodyText.substring(0, 1000)}`);

  // Set up download event listener BEFORE clicking
  let downloadTriggered = false;
  let downloadSavedPath = null;

  const downloadPromise = page.waitForEvent('download', { timeout: 60000 }).then(async (dl) => {
    downloadTriggered = true;
    const url = dl.url();
    const filename = dl.suggestedFilename();
    console.log(`\n[DOWNLOAD EVENT] url=${url.substring(0, 120)}`);
    console.log(`[DOWNLOAD EVENT] suggestedFilename=${filename}`);

    // Save directly from download event
    downloadSavedPath = `${FIXTURES}/${filename}`;
    try {
      await dl.saveAs(downloadSavedPath);
      const st = statSync(downloadSavedPath);
      console.log(`[DOWNLOAD SAVED] ${downloadSavedPath} (${st.size} bytes)`);
    } catch (saveErr) {
      console.log(`[DOWNLOAD SAVE ERROR] ${saveErr.message}`);
      downloadSavedPath = null;
    }

    return { url, filename };
  }).catch((err) => {
    console.log(`[DOWNLOAD EVENT] Timeout/Error: ${err.message}`);
    return null;
  });

  // Click the download element
  if (downloadCandidates.length > 0) {
    const target = downloadCandidates[0].el;
    console.log(`\n[CLICK] Clicking: ${downloadCandidates[0].selector}`);
    try {
      await target.click({ timeout: 10000 });
    } catch (e) {
      console.log(`[CLICK] Error: ${e.message}`);
    }
  } else {
    console.log(`\n[CLICK] No download candidate found.`);
  }

  // Wait for download to complete (up to 90s for 63MB)
  console.log(`[WAIT] Waiting up to 90s for download to complete...`);
  const dlResult = await Promise.race([
    downloadPromise,
    new Promise((resolve) => setTimeout(() => { console.log(`[WAIT] 90s timeout reached`); resolve(null); }, 90000))
  ]);

  // Analyze the saved file
  if (downloadSavedPath && existsSync(downloadSavedPath)) {
    const { execSync } = await import('child_process');
    const st = statSync(downloadSavedPath);
    console.log(`\n[FILE] ${downloadSavedPath} - ${st.size} bytes`);

    // Read first 16 bytes for magic
    const buf = readFileSync(downloadSavedPath);
    if (buf.length >= 4) {
      const magic4 = buf.subarray(0, 4).toString('hex');
      const magic16 = buf.subarray(0, 16).toString('hex');
      console.log(`[MAGIC] First 4 bytes: ${magic4}`);
      console.log(`[MAGIC] First 16 bytes: ${magic16}`);
      if (magic4 === '1a45dfa3') {
        summary.magicConfirmed = 'MKV (EBML header: 1a45dfa3)';
      } else if (magic4 === '66747970') {
        summary.magicConfirmed = 'MP4 (ftyp: 66747970)';
      } else {
        summary.magicConfirmed = `Unknown (${magic4})`;
      }
      console.log(`[MAGIC] Confirmed: ${summary.magicConfirmed}`);
    }

    // ffprobe
      try {
      const ffResult = execSync(`ffprobe -v error -show_format -show_streams "${downloadSavedPath}" 2>&1`, { encoding: 'utf-8', timeout: 30000 });
      console.log(`\n[FFPROBE]\n${ffResult}`);
      summary.ffprobeResult = ffResult.substring(0, 600);
    } catch (ffErr) {
      console.log(`[FFPROBE] Error: ${ffErr.message.substring(0, 300)}`);
      summary.ffprobeResult = ffErr.message.substring(0, 300);
    }
  } else if (dlResult && dlResult.url) {
    // Download event fired but save failed - try fetching separately
    console.log(`\n[FETCH] Download save failed, fetching via context.request...`);
    try {
      const resp = await context.request.get(dlResult.url);
      const ct = resp.headers()['content-type'] || '';
      const cl = resp.headers()['content-length'] || '';
      const cd = resp.headers()['content-disposition'] || '';
      console.log(`[FETCH] Status: ${resp.status()}`);
      console.log(`[FETCH] Content-Type: ${ct}`);
      console.log(`[FETCH] Content-Length: ${cl}`);
      console.log(`[FETCH] Content-Disposition: ${cd}`);
      summary.finalContentType = ct;

      const buf = await resp.body();
      console.log(`[FETCH] Got ${buf.length} bytes`);
      if (buf.length >= 4) {
        const magic4 = buf.subarray(0, 4).toString('hex');
        console.log(`[MAGIC] First 4 bytes: ${magic4}`);
        if (magic4 === '1a45dfa3') summary.magicConfirmed = 'MKV (EBML header: 1a45dfa3)';
        else if (magic4 === '66747970') summary.magicConfirmed = 'MP4 (ftyp: 66747970)';
        else summary.magicConfirmed = `Unknown (${magic4})`;
        console.log(`[MAGIC] Confirmed: ${summary.magicConfirmed}`);

        const ext = ct.includes('matroska') ? 'mkv' : ct.includes('mp4') ? 'mp4' : 'bin';
        const savePath = `${FIXTURES}/fetched_${dlResult.filename || `file.${ext}`}`;
        writeFileSync(savePath, buf);
        console.log(`[SAVE] Saved to ${savePath}`);

        try {
          const ffResult = execSync(`ffprobe -v error -show_format -show_streams "${savePath}" 2>&1`, { encoding: 'utf-8', timeout: 30000 });
          console.log(`\n[FFPROBE]\n${ffResult}`);
          summary.ffprobeResult = ffResult.substring(0, 600);
        } catch (ffErr) {
          console.log(`[FFPROBE] Error: ${ffErr.message.substring(0, 300)}`);
          summary.ffprobeResult = ffErr.message.substring(0, 300);
        }
      }
    } catch (fetchErr) {
      console.log(`[FETCH] Error: ${fetchErr.message.substring(0, 300)}`);
    }
  } else {
    // No download event at all - check current page
    console.log(`\n[NO DOWNLOAD] Trying current page URL...`);
    try {
      const resp = await context.request.get(page.url());
      const ct = resp.headers()['content-type'] || '';
      const cl = resp.headers()['content-length'] || '';
      console.log(`[RESPONSE] CT: ${ct}, CL: ${cl}, Status: ${resp.status()}`);
      summary.finalContentType = ct;
    } catch (e) {
      console.log(`[RESPONSE] Error: ${e.message}`);
    }
  }

  summary.staticWorked = summary.magicConfirmed !== '';
  summary.headlessNeeded = !summary.staticWorked;
  summary.downloadEventVsNavigation = downloadTriggered ? 'download-event' : 'no-download';

  // Print response summary
  console.log(`\n\n========== ALL RESPONSES (${responses.length}) ==========`);
  responses.forEach((r, i) => {
    const relevant = (r.contentType.includes('video') || r.contentType.includes('octet') ||
      r.contentType.includes('html') || r.contentDisposition) ? ' ***' : '';
    console.log(`  ${i}: [${r.status}] ${r.url.substring(0, 140)}`);
    console.log(`      CT=${r.contentType} CL=${r.contentLength} CD=${r.contentDisposition}${relevant}`);
  });

  // Final summary
  console.log(`\n\n========== FINAL SUMMARY ==========`);
  console.log(JSON.stringify(summary, null, 2));

  await browser.close();
})();
