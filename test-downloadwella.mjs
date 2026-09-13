import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

const TARGET_URL = 'https://downloadwella.com/dy0ui8qfzp9u/Jujutsu.Kaisen.S03E09.(THENKIRI.COM).mkv.html';
const DOWNLOAD_TIMEOUT = 60000;

(async () => {
  const allResponses = [];
  const logs = [];

  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    logs.push(line);
  };

  log('=== Playwright Download Test - downloadwella.com ===');
  log('Launching Chromium (headless, no-sandbox)...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Record ALL responses
  page.on('response', (response) => {
    const ct = response.headers()['content-type'] || '';
    const cl = response.headers()['content-length'] || '';
    const cd = response.headers()['content-disposition'] || '';
    const status = response.status();
    const url = response.url();
    allResponses.push({ url, status, contentType: ct, contentLength: cl, contentDisposition: cd });
    // Log only first 120 chars of URL to keep output manageable
    log(`RESPONSE [${status}] CT=${ct} CL=${cl} CD="${cd}" URL=${url.substring(0, 120)}`);
  });

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      log(`FRAME NAVIGATED to: ${frame.url()}`);
    }
  });

  context.on('page', async (newPage) => {
    log(`NEW PAGE OPENED: ${newPage.url()}`);
    await newPage.waitForLoadState('domcontentloaded').catch(() => {});
    log(`New page title: ${await newPage.title()}`);
    // Check if the new page has a download link
    const newPageContent = await newPage.evaluate(() => document.body?.innerText?.substring(0, 2000) || '');
    log(`New page text: ${newPageContent.substring(0, 500)}`);
  });

  // ========== STEP 1: Navigate to page ==========
  log(`=== STEP 1: Navigating to: ${TARGET_URL} ===`);
  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    log(`Navigation error: ${e.message}`);
  }

  log(`Page URL: ${page.url()}`);
  log(`Page title: ${await page.title()}`);

  // Wait 5 seconds
  log('Waiting 5 seconds for page to settle...');
  await page.waitForTimeout(5000);

  // ========== STEP 2: Analyze the page ==========
  log('=== STEP 2: Page Analysis ===');

  const pageTitle = await page.title();
  log(`PAGE TITLE: ${pageTitle}`);

  // Extract inline scripts
  log('=== INLINE SCRIPTS ===');
  const scripts = await page.evaluate(() => {
    const els = document.querySelectorAll('script');
    const results = [];
    for (const el of els) {
      if (el.textContent && el.textContent.trim().length > 0) {
        results.push(el.textContent.substring(0, 3000));
      }
    }
    return results;
  });
  for (let i = 0; i < scripts.length; i++) {
    log(`--- Script #${i + 1} ---`);
    log(scripts[i]);
  }

  // Extract all links and buttons
  log('=== ALL LINKS AND BUTTONS ===');
  const elements = await page.evaluate(() => {
    const results = [];
    for (const a of document.querySelectorAll('a')) {
      results.push({
        tag: 'a', text: a.textContent?.trim()?.substring(0, 200) || '',
        href: a.href || '', id: a.id || '', class: a.className || '',
        disabled: a.disabled || false,
      });
    }
    for (const b of document.querySelectorAll('button, input[type="submit"], input[type="button"]')) {
      results.push({
        tag: 'button', text: b.textContent?.trim()?.substring(0, 200) || b.value || '',
        href: '', id: b.id || '', class: b.className || '',
        disabled: b.disabled || false,
      });
    }
    for (const d of document.querySelectorAll('[onclick], [role="button"], .btn, [class*="download"], [class*="timer"], [class*="countdown"]')) {
      results.push({
        tag: d.tagName.toLowerCase(), text: d.textContent?.trim()?.substring(0, 200) || '',
        href: '', id: d.id || '', class: d.className || '',
        disabled: false, onclick: d.getAttribute('onclick') || '',
      });
    }
    return results;
  });
  for (const el of elements) {
    log(`${el.tag} | text="${el.text}" | href="${el.href}" | id="${el.id}" | class="${el.class}" | disabled=${el.disabled}`);
  }

  // Check page text
  log('=== PAGE TEXT ===');
  const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 5000) || '');
  log(pageText);

  // ========== STEP 3: Submit form (click "Create download link") ==========
  log('=== STEP 3: Submitting form (Create download link) ===');

  // Set up download event listener
  const downloadPromise = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT }).then((download) => {
    log(`DOWNLOAD EVENT: URL=${download.url()}, filename=${download.suggestedFilename()}`);
    return download;
  }).catch((e) => {
    log(`Download event timeout: ${e.message}`);
    return null;
  });

  // Submit via JS
  await page.evaluate(() => {
    const btn = document.querySelector('#downloadbtn');
    if (btn && btn.form) {
      btn.form.submit();
    }
  });
  log('Form submitted via JS');

  // Wait for navigation
  try {
    await page.waitForNavigation({ timeout: 15000 });
  } catch (e) {
    log(`Navigation wait: ${e.message}`);
  }

  log(`Post-submit URL: ${page.url()}`);
  log(`Post-submit title: ${await page.title()}`);

  // ========== STEP 4: Analyze post-submit page ==========
  await page.waitForTimeout(3000);

  log('=== STEP 4: Post-Submit Page Analysis ===');
  const postPageText = await page.evaluate(() => document.body?.innerText?.substring(0, 5000) || '');
  log(postPageText);

  // Extract links and buttons from post-submit page
  log('=== POST-SUBMIT LINKS AND BUTTONS ===');
  const postElements = await page.evaluate(() => {
    const results = [];
    for (const a of document.querySelectorAll('a')) {
      results.push({
        tag: 'a', text: a.textContent?.trim()?.substring(0, 200) || '',
        href: a.href || '', id: a.id || '', class: a.className || '',
      });
    }
    for (const b of document.querySelectorAll('button, input[type="submit"]')) {
      results.push({
        tag: 'button', text: b.textContent?.trim()?.substring(0, 200) || b.value || '',
        href: '', id: b.id || '', class: b.className || '',
      });
    }
    return results;
  });
  for (const el of postElements) {
    log(`${el.tag} | text="${el.text}" | href="${el.href}" | id="${el.id}" | class="${el.class}"`);
  }

  // Look for countdown
  log('=== POST-SUBMIT SCRIPTS ===');
  const postScripts = await page.evaluate(() => {
    const els = document.querySelectorAll('script');
    const results = [];
    for (const el of els) {
      if (el.textContent && el.textContent.trim().length > 0) {
        results.push(el.textContent.substring(0, 3000));
      }
    }
    return results;
  });
  for (let i = 0; i < postScripts.length; i++) {
    if (/download|countdown|timer|wait|cooldown|link/i.test(postScripts[i])) {
      log(`--- Relevant Script #${i + 1} ---`);
      log(postScripts[i]);
    }
  }

  // Check for countdown
  const countdownMatch = postPageText.match(/(\d+)\s*(?:seconds?|sec|minutes?|min|waiting|wait|remaining)/i);
  if (countdownMatch) {
    log(`COUNTDOWN DETECTED: "${countdownMatch[0]}"`);

    // Extract the countdown value
    const seconds = parseInt(countdownMatch[1]);
    log(`Waiting ${seconds + 5} seconds for countdown to finish...`);
    await page.waitForTimeout((seconds + 5) * 1000);

    // Re-check page after countdown
    log('=== POST-COUNTDOWN PAGE ===');
    const afterCountdownText = await page.evaluate(() => document.body?.innerText?.substring(0, 5000) || '');
    log(afterCountdownText);

    const afterCountdownLinks = await page.evaluate(() => {
      const results = [];
      for (const a of document.querySelectorAll('a')) {
        results.push({
          tag: 'a', text: a.textContent?.trim()?.substring(0, 200) || '',
          href: a.href || '', id: a.id || '', class: a.className || '',
        });
      }
      for (const b of document.querySelectorAll('button')) {
        results.push({
          tag: 'button', text: b.textContent?.trim()?.substring(0, 200) || '',
          href: '', id: b.id || '', class: b.className || '',
        });
      }
      return results;
    });
    log('POST-COUNTDOWN ELEMENTS:');
    for (const el of afterCountdownLinks) {
      log(`${el.tag} | text="${el.text}" | href="${el.href}" | id="${el.id}" | class="${el.class}"`);
    }
  }

  // ========== STEP 5: Find and click the actual download link ==========
  log('=== STEP 5: Looking for actual download link ===');

  // Look for download link patterns typical in XFileSharing
  const downloadLink = await page.evaluate(() => {
    // Look for links that seem to be download links
    for (const a of document.querySelectorAll('a')) {
      const href = a.href || '';
      const text = (a.textContent || '').trim().toLowerCase();
      const cls = (a.className || '').toLowerCase();
      // XFileSharing download links often contain /download/ or have special patterns
      if (href.includes('/download/') || cls.includes('download-link') || cls.includes('download_link') ||
          (text.includes('download') && href && !href.includes('javascript') && !href.includes('premium'))) {
        return { href: a.href, text: a.textContent?.trim(), class: a.className, id: a.id };
      }
    }
    // Also check buttons
    for (const b of document.querySelectorAll('button, input[type="submit"]')) {
      const text = (b.textContent || b.value || '').trim().toLowerCase();
      const id = (b.id || '').toLowerCase();
      if (id.includes('download') && id !== 'downloadbtn') {
        return { href: '', text: b.textContent?.trim() || b.value, class: b.className, id: b.id, isButton: true };
      }
    }
    return null;
  });

  if (downloadLink) {
    log(`FOUND DOWNLOAD LINK: ${JSON.stringify(downloadLink)}`);

    if (downloadLink.href) {
      log(`Navigating to download URL: ${downloadLink.href}`);
      try {
        const [download, navResponse] = await Promise.all([
          downloadPromise,
          page.goto(downloadLink.href, { timeout: 30000 }).catch(e => {
            log(`Nav error: ${e.message}`);
            return null;
          }),
        ]);

        if (download) {
          log('=== DOWNLOAD EVENT FROM NAVIGATION ===');
          handleDownload(download, downloadLink.href);
        } else {
          // Check what we landed on
          const finalText = await page.evaluate(() => document.body?.innerText?.substring(0, 2000) || '');
          log(`Final page text: ${finalText.substring(0, 500)}`);

          // Check if it's a direct download response
          try {
            const resp = await context.request.get(downloadLink.href);
            const headers = resp.headers();
            log(`Response CT: ${headers['content-type']}`);
            log(`Response CD: ${headers['content-disposition']}`);
            log(`Response CL: ${headers['content-length']}`);

            if (headers['content-disposition'] || headers['content-type']?.includes('octet-stream')) {
              const bytes = await resp.body();
              log(`Body bytes: ${bytes.length}`);
              const magicHex = Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
              log(`Magic bytes: ${magicHex}`);
            }
          } catch (e) {
            log(`Direct fetch error: ${e.message}`);
          }
        }
      } catch (e) {
        log(`Download navigation error: ${e.message}`);
      }
    } else {
      log('Download element is a button, clicking...');
      try {
        const selector = downloadLink.id ? `#${downloadLink.id}` : `button:has-text("${downloadLink.text}")`;
        await page.click(selector, { force: true, timeout: 10000 });
        log('Button clicked');

        const download = await Promise.race([
          downloadPromise,
          new Promise(r => setTimeout(() => r(null), 30000)),
        ]);
        if (download) {
          handleDownload(download, download.url());
        }
      } catch (e) {
        log(`Button click error: ${e.message}`);
      }
    }
  } else {
    log('No specific download link found, trying direct fetch of current page');

    // Try to find any link with /cgi-bin/ or similar download patterns
    const allLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a')).map(a => ({ href: a.href, text: a.textContent?.trim() }));
    });

    log('ALL HREFS:');
    for (const l of allLinks) {
      log(`  ${l.text}: ${l.href}`);
    }

    // Try fetching the page with POST to see if we get a download link
    try {
      const response = await context.request.get(page.url());
      const text = await response.text();
      // Look for download URLs in the HTML
      const downloadUrls = text.match(/https?:\/\/[^\s"'<>]+(?:download|file|get)[^\s"'<>]*/gi) || [];
      log(`Download URLs found in HTML: ${downloadUrls.length}`);
      for (const u of downloadUrls) {
        log(`  ${u}`);
      }
    } catch (e) {
      log(`Page fetch error: ${e.message}`);
    }
  }

  function handleDownload(download, url) {
    log(`Download: URL=${url}, filename=${download.suggestedFilename()}`);
    // ... (same as before)
  }

  // Wait for the download promise
  const download = await downloadPromise;

  if (download) {
    const filename = download.suggestedFilename();
    const downloadUrl = download.url();
    const savePath = `C:\\Users\\fidel\\AppData\\Local\\Temp\\opencode\\downloaded_${filename}`;

    log(`=== DOWNLOAD RECEIVED ===`);
    log(`URL: ${downloadUrl}`);
    log(`Filename: ${filename}`);

    try {
      await download.saveAs(savePath);
      log(`Saved to: ${savePath}`);
    } catch (e) {
      log(`Save error: ${e.message}`);
    }

    // Fetch via context.request
    try {
      log('=== Fetching via context.request ===');
      const response = await context.request.get(downloadUrl);
      const headers = response.headers();
      const status = response.status();
      const bytes = await response.body();

      log(`Status: ${status}`);
      log(`CT: ${headers['content-type']}`);
      log(`CL: ${headers['content-length']}`);
      log(`CD: ${headers['content-disposition']}`);
      log(`Bytes: ${bytes.length}`);

      const magicHex = Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      log(`Magic bytes: ${magicHex}`);

      if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
        log('Confirmed MKV (1A 45 DF A3)');
      } else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
        log('Confirmed RIFF/AVI (52 49 46 46)');
      } else {
        log('Unknown format from magic bytes');
        const textStart = bytes.toString('utf-8', 0, Math.min(300, bytes.length));
        if (textStart.includes('<html') || textStart.includes('<!DOCTYPE')) {
          log('WARNING: Got HTML, not media!');
          log(textStart.substring(0, 500));
        }
      }

      // ffprobe
      try {
        log('=== ffprobe ===');
        const result = execSync(`ffprobe -v quiet -print_format json -show_format -show_streams "${savePath}"`, { timeout: 15000, encoding: 'utf-8' });
        log(result);
      } catch (e) {
        log(`ffprobe error: ${e.message}`);
      }
    } catch (e) {
      log(`context.request error: ${e.message}`);
    }
  } else {
    log('=== NO DOWNLOAD EVENT ===');

    // Final fallback: check current page
    try {
      const response = await context.request.get(page.url());
      const headers = response.headers();
      log(`Current page CT: ${headers['content-type']}`);
      log(`Current page CD: ${headers['content-disposition']}`);

      const bytes = await response.body();
      const text = bytes.toString('utf-8');

      // Extract all download-related URLs from the page HTML
      const matches = [...text.matchAll(/href=["']([^"']+)["']/gi)];
      const downloadUrls = matches
        .map(m => m[1])
        .filter(h => h.includes('download') || h.includes('file') || h.includes('get') || h.includes('/cgi-bin/'))
        .filter(h => !h.includes('.css') && !h.includes('.js') && !h.includes('.png'));

      log(`Download-like URLs in page HTML: ${downloadUrls.length}`);
      for (const u of downloadUrls) {
        log(`  ${u}`);
      }

      // Check the countdown.js script
      log('=== Checking countdown.js ===');
      const countdownScript = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('script[src*="countdown"]')).map(s => s.src);
      });
      log(`Countdown scripts: ${JSON.stringify(countdownScript)}`);

    } catch (e) {
      log(`Final check error: ${e.message}`);
    }
  }

  // Final summary
  log('=== RESPONSE SUMMARY ===');
  log(`Total responses: ${allResponses.length}`);
  const largeResponses = allResponses.filter(r => r.contentLength && parseInt(r.contentLength) > 10000);
  for (const r of largeResponses) {
    log(`LARGE: [${r.status}] ${r.contentType} ${r.contentLength}B ${r.url.substring(0, 100)}`);
  }
  const mediaResponses = allResponses.filter(r =>
    r.contentDisposition || r.contentType.includes('octet-stream') || r.contentType.includes('video') || r.contentType.includes('audio')
  );
  if (mediaResponses.length > 0) {
    log('MEDIA RESPONSES:');
    for (const r of mediaResponses) {
      log(`[${r.status}] CT=${r.contentType} CL=${r.contentLength} CD="${r.contentDisposition}" ${r.url.substring(0, 100)}`);
    }
  }

  await browser.close();
  log('=== TEST COMPLETE ===');
  writeFileSync('C:\\Users\\fidel\\AppData\\Local\\Temp\\opencode\\test-downloadwella.log', logs.join('\n'));
})();
