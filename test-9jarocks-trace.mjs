import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

// Episode 1 - S01E01
const EP1_URL = 'https://9jarocks.net/videodownload/daemons-of-the-shadow-realm-season-1-anime-id384308.html';
// Episode 2 - S01E02 (if available, same series page)
const EP2_URL = 'https://9jarocks.net/videodownload/daemons-of-the-shadow-realm-season-1-anime-id384308.html';

async function traceHops(page, startUrl, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`=== ${label} ===`);
  console.log(`Start URL: ${startUrl.substring(0, 120)}`);

  const hops = [];
  let currentUrl = startUrl;
  let hopCount = 0;
  const MAX_HOPS = 10;

  while (hopCount < MAX_HOPS) {
    hopCount++;
    console.log(`\n--- HOP ${hopCount}: ${currentUrl.substring(0, 150)} ---`);

    const response = await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => {
      console.log(`  Nav error: ${e.message.substring(0, 80)}`);
      return null;
    });

    if (!response) break;

    const status = response.status();
    const headers = response.headers();
    const ct = headers['content-type'] || 'none';
    const cl = headers['content-length'] || 'none';
    const cd = headers['content-disposition'] || 'none';
    const location = headers['location'] || 'none';

    console.log(`  Status: ${status}`);
    console.log(`  Content-Type: ${ct}`);
    console.log(`  Content-Length: ${cl}`);
    console.log(`  Content-Disposition: ${cd}`);
    console.log(`  Location: ${location}`);
    console.log(`  Final URL: ${page.url().substring(0, 150)}`);

    hops.push({
      hop: hopCount,
      url: currentUrl,
      finalUrl: page.url(),
      status,
      contentType: ct,
      contentLength: cl,
      contentDisposition: cd,
      location,
    });

    // Check if this is a real file response
    const isMedia = ct.includes('video/') || ct.includes('audio/') || ct.includes('application/octet-stream')
      || ct.includes('application/x-matroska') || /attachment/i.test(cd)
      || ct.includes('application/x-rar') || ct.includes('application/zip');

    if (isMedia) {
      console.log(`  *** MEDIA FILE DETECTED! ***`);
      // Download first 1024 bytes
      const body = await response.body();
      const first16 = body.subarray(0, 16).toString('hex');
      const first64 = body.subarray(0, 64).toString('hex');
      console.log(`  First 16 bytes (hex): ${first16}`);
      console.log(`  First 64 bytes (hex): ${first64}`);
      console.log(`  MKV magic (1a45dfa3): ${first16.startsWith('1a45dfa3') ? 'YES ✓' : 'NO ✗'}`);
      console.log(`  MP4 magic (ftyp): ${first16.substring(4, 8) === '66747970' ? 'YES ✓' : 'NO ✗'}`);
      console.log(`  RAR magic (52617221): ${first16.startsWith('52617221') ? 'YES ✓' : 'NO ✗'}`);
      console.log(`  ZIP magic (504b0304): ${first16.startsWith('504b0304') ? 'YES ✓' : 'NO ✗'}`);
      console.log(`  Body total: ${body.length} bytes (${(body.length / 1024 / 1024).toFixed(2)} MB)`);
      return { hops, mediaUrl: page.url(), contentType: ct, contentLength: cl, magic: first16, bodySize: body.length };
    }

    // If HTML, wait for page to load and extract next URL
    if (ct.includes('text/html')) {
      await page.waitForTimeout(3000);

      // Check if page has auto-redirect via meta refresh
      const metaRefresh = await page.evaluate(() => {
        const meta = document.querySelector('meta[http-equiv="refresh"]');
        return meta ? meta.getAttribute('content') : null;
      });
      if (metaRefresh) {
        console.log(`  Meta refresh: ${metaRefresh}`);
        const urlMatch = metaRefresh.match(/url=(.+)/i);
        if (urlMatch) {
          currentUrl = urlMatch[1];
          continue;
        }
      }

      // Check for JS redirect
      const jsRedirect = await page.evaluate(() => {
        // Look for window.location assignments in scripts
        const scripts = document.querySelectorAll('script:not([src])');
        for (const s of scripts) {
          const text = s.textContent;
          if (!text) continue;
          const locMatch = text.match(/window\.location(?:\.href)?\s*=\s*['"](https?:\/\/[^'"]+)['"]/);
          if (locMatch) return locMatch[1];
        }
        return null;
      });
      if (jsRedirect) {
        console.log(`  JS redirect to: ${jsRedirect.substring(0, 150)}`);
        currentUrl = jsRedirect;
        continue;
      }

      // Extract download URLs from the page
      const pageLinks = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href]');
        return Array.from(links).map(a => ({
          text: a.textContent?.trim()?.substring(0, 80) || '',
          href: a.href,
        })).filter(l => l.href.startsWith('http'));
      });

      console.log(`  Page links (${pageLinks.length}):`);
      const downloadLinks = [];
      for (const l of pageLinks) {
        const isDownload = /download|proceed|click here|get link|file/i.test(l.text) ||
          /\.mkv|\.mp4|\.avi|\.zip|\.rar/i.test(l.href) ||
          /download|file/i.test(l.href);
        if (isDownload || l.text.length < 40) {
          console.log(`    "${l.text.substring(0, 50)}" -> ${l.href.substring(0, 120)}`);
        }
        if (isDownload) downloadLinks.push(l);
      }

      // Extract download URLs from page HTML
      const inlineUrls = await page.evaluate(() => {
        const html = document.documentElement.outerHTML;
        const urls = [];
        // Find all http URLs
        const matches = html.match(/https?:\/\/[^\s"'<>]+/g) || [];
        for (const u of matches) {
          if (/loadedfiles|1fichier|download|\.mkv|\.mp4|file/i.test(u) && !/google|facebook|twitter|analytics|cloudflare|fonts/i.test(u)) {
            urls.push(u.substring(0, 200));
          }
        }
        return [...new Set(urls)];
      });

      if (inlineUrls.length > 0) {
        console.log(`  Notable inline URLs:`);
        for (const u of inlineUrls) {
          console.log(`    ${u.substring(0, 150)}`);
        }
      }

      // Check for loadedfiles direct links (these are often the real file hosts)
      const lfLinks = downloadLinks.filter(l => /loadedfiles/i.test(l.href));
      if (lfLinks.length > 0) {
        console.log(`\n  Found ${lfLinks.length} loadedfiles.net links, following first...`);
        currentUrl = lfLinks[0].href;
        continue;
      }

      // Check for 1fichier links
      const ufLinks = downloadLinks.filter(l => /1fichier/i.test(l.href));
      if (ufLinks.length > 0) {
        console.log(`\n  Found ${ufLinks.length} 1fichier links:`);
        for (const l of ufLinks) {
          console.log(`    "${l.text}" -> ${l.href.substring(0, 150)}`);
        }
      }

      // If no more download links, we're stuck
      if (downloadLinks.length === 0 && inlineUrls.length === 0) {
        console.log(`  No download links found, stopping.`);
        break;
      }

      // Try the first non-loadedfiles download link
      const otherLinks = downloadLinks.filter(l => !/loadedfiles/i.test(l.href));
      if (otherLinks.length > 0) {
        currentUrl = otherLinks[0].href;
        continue;
      }

      break;
    } else {
      console.log(`  Non-HTML response, stopping.`);
      break;
    }
  }

  return { hops };
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  // STEP 1a: Get the 9jarocks page and extract ALL download CTAs
  const page = await context.newPage();
  console.log('=== Loading 9jarocks landing page ===');
  await page.goto(EP1_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log(`Title: ${await page.title()}`);

  // Extract all links with their full details
  const allLinks = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href]');
    return Array.from(links).map(a => ({
      text: a.textContent?.trim()?.substring(0, 100) || '',
      href: a.href,
      cls: a.className?.substring(0, 60) || '',
    })).filter(l => l.href.startsWith('http'));
  });

  console.log(`\nAll links (${allLinks.length}):`);
  const downloadLinks = [];
  for (const l of allLinks) {
    const isDownload = /download|proceed|click|get|mirror|mp4|mkv/i.test(l.text) ||
      /9jarocks1\.php|loadedfiles|1fichier|download/i.test(l.href);
    if (isDownload) {
      console.log(`  [DL] "${l.text.substring(0, 60)}" -> ${l.href.substring(0, 150)} class="${l.cls}"`);
      downloadLinks.push(l);
    }
  }

  console.log(`\nFound ${downloadLinks.length} download CTAs`);

  // Also extract ALL inline URLs that might be download links
  const inlineUrls = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    const urls = [];
    const regex = /https?:\/\/[^\s"'<>]+/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      const u = m[0];
      if (/9jarocks1\.php|loadedfiles|1fichier|downloadwella|wideshares|\.mkv|\.mp4/i.test(u)) {
        urls.push(u.substring(0, 200));
      }
    }
    return [...new Set(urls)];
  });
  console.log(`\nInline download-related URLs:`);
  for (const u of inlineUrls) {
    console.log(`  ${u.substring(0, 150)}`);
  }

  // Now trace the 9jarocks1.php URL with a fresh context (no cookies from 9jarocks page)
  const phpLinks = downloadLinks.filter(l => /9jarocks1\.php/i.test(l.href));
  const lfLinks = downloadLinks.filter(l => /loadedfiles/i.test(l.href));

  // Test 9jarocks1.php redirect chain
  if (phpLinks.length > 0) {
    console.log(`\n\n=== TRACING 9jarocks1.php REDIRECT CHAIN ===`);
    const testPage = await context.newPage();
    const result = await traceHops(testPage, phpLinks[0].href, '9jarocks1.php redirect chain');
    if (result?.mediaUrl) {
      console.log(`\n*** RESOLVED: ${result.mediaUrl}`);
      console.log(`*** Content-Type: ${result.contentType}`);
      console.log(`*** Magic: ${result.magic}`);
    }
    await testPage.close();
  }

  // Test loadedfiles.net direct link
  if (lfLinks.length > 0) {
    console.log(`\n\n=== TRACING loadedfiles.net LINK ===`);
    const testPage2 = await context.newPage();
    const result2 = await traceHops(testPage2, lfLinks[0].href, 'loadedfiles.net chain');
    if (result2?.mediaUrl) {
      console.log(`\n*** RESOLVED: ${result2.mediaUrl}`);
      console.log(`*** Content-Type: ${result2.contentType}`);
      console.log(`*** Magic: ${result2.magic}`);
    }
    await testPage2.close();
  }

  // If no CTAs found in links, try the PHP link directly from known patterns
  if (downloadLinks.length === 0) {
    console.log('\n=== No CTAs found, extracting from raw HTML ===');
    const html = await page.content();
    // Find 9jarocks1.php links
    const phpMatches = html.match(/https?:\/\/9jarocks\.net\/wp-content\/url\/9jarocks1\.php\?[^"'\s<>]+/g) || [];
    console.log(`PHP links found: ${phpMatches.length}`);
    for (const m of phpMatches) {
      console.log(`  ${m.substring(0, 200)}`);
    }

    // Find loadedfiles links
    const lfMatches = html.match(/https?:\/\/loadedfiles\.net\/[^\s"'<>]+/g) || [];
    console.log(`Loadedfiles links: ${lfMatches.length}`);
    for (const m of lfMatches) {
      console.log(`  ${m.substring(0, 200)}`);
    }

    if (phpMatches.length > 0) {
      const testPage3 = await context.newPage();
      await traceHops(testPage3, phpMatches[0], '9jarocks1.php (from HTML)');
      await testPage3.close();
    }
  }

  await browser.close();
})();
