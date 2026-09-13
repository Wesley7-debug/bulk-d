import { chromium } from 'playwright';
import https from 'https';
import http from 'http';
import { writeFileSync, statSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';

// Refresh PATH for ffprobe
const ffprobePath = (() => {
  try {
    execSync('ffprobe -version', { stdio: 'ignore' });
    return 'ffprobe';
  } catch {
    const machinePath = execSync('[System.Environment]::GetEnvironmentVariable("Path","Machine")', { shell: 'powershell', stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    const userPath = execSync('[System.Environment]::GetEnvironmentVariable("Path","User")', { shell: 'powershell', stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    const full = machinePath + ';' + userPath;
    for (const p of full.split(';')) {
      if (existsSync(p + '/ffprobe.exe')) return p + '/ffprobe.exe';
    }
    return null;
  }
})();
console.log(`ffprobe: ${ffprobePath || 'NOT FOUND'}`);

function httpGet(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) loc = new URL(url).origin + loc;
        httpGet(loc, maxRedirects - 1).then(resolve).catch(reject);
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function runFfprobe(filePath) {
  if (!ffprobePath) return 'ffprobe not available';
  try {
    return execSync(`"${ffprobePath}" -v error -show_format -show_streams "${filePath}"`, { timeout: 30000 }).toString();
  } catch (e) {
    return `ffprobe error: ${(e.message || '').substring(0, 200)}`;
  }
}

async function resolveLoadedfilesEpisode(context, episodeUrl, label) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`=== ${label}: ${episodeUrl.substring(0, 120)} ===`);

  const result = { url: episodeUrl, staticWorked: false, headlessNeeded: true, cdnUrl: null, contentType: null, contentLength: null, magicBytes: null, ffprobe: null, hops: 0, interstitial: false, downloadEventPattern: false };

  const page = await context.newPage();
  let cdnUrl = null, cdnHeaders = null;
  page.on('response', async (response) => {
    const ct = response.headers()['content-type'] || '';
    const cd = response.headers()['content-disposition'] || '';
    if ((ct.includes('video/') || ct.includes('audio/') || /attachment/i.test(cd)) && !cdnUrl) {
      cdnUrl = response.url();
      cdnHeaders = response.headers();
    }
  });

  try {
    // Step 1: Try static HEAD request first
    console.log('\n--- Static HEAD request ---');
    const staticResp = await httpGet(episodeUrl).catch(e => null);
    if (staticResp) {
      console.log(`Status: ${staticResp.status} CT: ${staticResp.headers['content-type']}`);
      if (staticResp.headers['content-type']?.includes('video') || /attachment/i.test(staticResp.headers['content-disposition'] || '')) {
        result.staticWorked = true;
        console.log('*** Static request returned media directly! ***');
        cdnUrl = episodeUrl;
        cdnHeaders = staticResp.headers;
      } else {
        console.log('Static request returned HTML - headless needed');
      }
    }

    if (!result.staticWorked) {
      // Step 2: Load landing page
      console.log('\n--- Page 1: Landing page ---');
      await page.goto(episodeUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);

      const pt1 = await page.evaluate(() => {
        for (const s of document.querySelectorAll('script')) {
          const m = s.textContent?.match(/downloadUrl\s*=\s*['"]([^'"]+)['"]/);
          if (m) return m[1];
        }
        return null;
      });

      if (!pt1) {
        console.log('No pt= URL found on landing page - different site pattern?');
        await page.close();
        result.hops = 1;
        return result;
      }

      result.hops = 1;
      result.interstitial = true;
      console.log(`pt1: ${pt1.substring(0, 120)}`);

      // Wait cooldown
      console.log('Waiting 22s cooldown...');
      await page.waitForTimeout(22000);
      await page.evaluate(() => { window.open = () => null; });

      // Step 3: Navigate to pt1
      console.log('\n--- Page 2: Navigate to pt1 ---');
      await page.goto(pt1, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);

      const pt2 = await page.evaluate(() => {
        for (const s of document.querySelectorAll('script')) {
          const m = s.textContent?.match(/downloadUrl\s*=\s*['"]([^'"]+)['"]/);
          if (m) return m[1];
        }
        return null;
      });
      result.hops = 2;

      if (pt2) {
        console.log(`pt2: ${pt2.substring(0, 120)}`);

        // Wait cooldown on Page 2
        console.log('Waiting 22s cooldown...');
        await page.waitForTimeout(22000);
        await page.evaluate(() => { window.open = () => null; });

        // Step 4: Click on Page 2
        console.log('\n--- Page 2: Click Download ---');
        const dlPromise = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
        await page.evaluate(() => { document.getElementById('downloadButton')?.click(); });

        const dl = await dlPromise;
        if (dl) {
          cdnUrl = dl.url();
          console.log(`Download event URL: ${cdnUrl.substring(0, 200)}`);
          result.downloadEventPattern = true;
        } else if (cdnUrl) {
          console.log(`Media URL from response listener: ${cdnUrl.substring(0, 200)}`);
          result.downloadEventPattern = true;
        }
        result.hops = 3;
      }
    }

    // Download and verify
    if (cdnUrl) {
      console.log(`\n--- Downloading from CDN ---`);
      const dlResp = await httpGet(cdnUrl).catch(e => null);
      if (dlResp && dlResp.body) {
        const savePath = `test-fixtures/crossval_${label.replace(/[^a-zA-Z0-9]/g, '_')}.mkv`;
        writeFileSync(savePath, dlResp.body);

        result.cdnUrl = cdnUrl;
        result.contentType = dlResp.headers['content-type'] || cdnHeaders?.['content-type'] || 'unknown';
        result.contentLength = dlResp.body.length;

        const first16 = dlResp.body.subarray(0, 16).toString('hex');
        result.magicBytes = first16;
        console.log(`\n=== VERIFICATION for ${label} ===`);
        console.log(`File: ${savePath}`);
        console.log(`Size: ${dlResp.body.length} bytes (${(dlResp.body.length / 1024 / 1024).toFixed(2)} MB)`);
        console.log(`Content-Type: ${result.contentType}`);
        console.log(`First 16 hex: ${first16}`);
        console.log(`MKV magic: ${first16.startsWith('1a45dfa3') ? 'YES' : 'NO'}`);

        if (ffprobePath) {
          result.ffprobe = runFfprobe(savePath);
          const durationMatch = result.ffprobe.match(/duration=([\d.]+)/);
          const codecMatch = result.ffprobe.match(/codec_name=(\w+)/);
          console.log(`Duration: ${durationMatch?.[1] || 'N/A'}s`);
          console.log(`Codec: ${codecMatch?.[1] || 'N/A'}`);
        }
      }
    }
  } catch (e) {
    console.log(`Error: ${e.message?.substring(0, 200)}`);
  }

  await page.close();
  return result;
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptDownloads: true,
  });

  const allResults = [];

  // ===== STEP 1: More Daemons episodes from 9jarocks =====
  console.log('\n' + '='.repeat(80));
  console.log('STEP 1: Multiple Daemons episodes from same 9jarocks job');
  console.log('='.repeat(80));

  // First, discover what episodes and links are on the 9jarocks page
  const discPage = await context.newPage();
  await discPage.goto('https://9jarocks.net/videodownload/daemons-of-the-shadow-realm-season-1-anime-id384308.html', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await discPage.waitForTimeout(3000);

  const episodeLinks = await discPage.evaluate(() => {
    const links = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      const text = a.textContent?.trim() || '';
      if (/loadedfiles\.net/.test(href) || /9jarocks1\.php/.test(href) || /download/i.test(text)) {
        links.push({ href, text: text.substring(0, 100) });
      }
    });
    return links;
  });

  console.log(`\nFound ${episodeLinks.length} download links on 9jarocks:`);
  for (const l of episodeLinks) {
    console.log(`  "${l.text.substring(0, 60)}" -> ${l.href.substring(0, 150)}`);
  }

  // Also look for individual episode download links
  const allEpLinks = await discPage.evaluate(() => {
    const links = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      const text = a.textContent?.trim() || '';
      if (/s01e\d+|episode.*\d+/i.test(text + ' ' + href) && /loadedfiles\.net/.test(href)) {
        links.push({ href, text: text.substring(0, 100) });
      }
    });
    return links;
  });

  console.log(`\nEpisode-specific loadedfiles links (${allEpLinks.length}):`);
  for (const l of allEpLinks) {
    console.log(`  "${l.text}" -> ${l.href.substring(0, 200)}`);
  }

  await discPage.close();

  // Test 2 more episodes (S01E02, S01E03) if links found
  // Use the same 9jarocks page hash pattern but different filenames
  const epUrls = [
    'https://loadedfiles.net/fdde7e3ed4e67090/Daemons.of.The.Shadow.Realm.S01E02.540p.x265.AAC.[9jaRocks.Com].mkv',
    'https://loadedfiles.net/fdde7e3ed4e67090/Daemons.of.The.Shadow.Realm.S01E03.540p.x265.AAC.[9jaRocks.Com].mkv',
  ];

  for (const url of epUrls) {
    const ep = url.match(/S01E(\d+)/)?.[1] || '??';
    const result = await resolveLoadedfilesEpisode(context, url, `S01E0${ep}`);
    allResults.push({ site: 'loadedfiles.net', episode: `S01E0${ep}`, ...result });
  }

  // ===== STEP 2: Cross-validate other sites =====
  console.log('\n\n' + '='.repeat(80));
  console.log('STEP 2: Cross-validate other sites');
  console.log('='.repeat(80));

  // Search for different sites with different anime titles
  const searchTitles = [
    'one piece episode 1 download',
    'jujutsu kaisen episode 1 download free',
  ];

  // For now, test known sites with the Daemons title or similar
  const crossSiteTests = [
    { name: 'wideshares.org', searchUrl: 'https://www.google.com/search?q=site:wideshares.org+daemons+shadow+realm+download' },
    { name: 'downloadwella.com', searchUrl: 'https://www.google.com/search?q=site:downloadwella.com+daemons+shadow+realm+download' },
    { name: '1fichier.com', searchUrl: 'https://www.google.com/search?q=site:1fichier.com+daemons+shadow+realm' },
  ];

  // Try to discover URLs for each site
  const searchPage = await context.newPage();
  for (const test of crossSiteTests) {
    console.log(`\n--- Searching for ${test.name} URLs ---`);
    await searchPage.goto(test.searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await searchPage.waitForTimeout(2000);

    const results = await searchPage.evaluate(() => {
      const links = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href;
        if (/wideshares\.org|downloadwella\.com|1fichier\.com/.test(href)) {
          links.push(href);
        }
      });
      return [...new Set(links)];
    });
    console.log(`Found ${results.length} results:`);
    for (const r of results) {
      console.log(`  ${r.substring(0, 200)}`);
    }
  }
  await searchPage.close();

  // Close context and browser
  await browser.close();

  // Print summary
  console.log('\n\n' + '='.repeat(80));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(80));
  for (const r of allResults) {
    console.log(`\n${r.site} ${r.episode}:`);
    console.log(`  Static worked: ${r.staticWorked}`);
    console.log(`  Headless needed: ${r.headlessNeeded}`);
    console.log(`  Download event pattern: ${r.downloadEventPattern}`);
    console.log(`  Hops: ${r.hops}`);
    console.log(`  Interstitial: ${r.interstitial}`);
    console.log(`  CDN URL: ${r.cdnUrl?.substring(0, 100) || 'none'}`);
    console.log(`  Content-Type: ${r.contentType}`);
    console.log(`  Size: ${r.contentLength ? `${r.contentLength} bytes (${(r.contentLength / 1024 / 1024).toFixed(2)} MB)` : 'unknown'}`);
    console.log(`  MKV magic: ${r.magicBytes?.startsWith('1a45dfa3') ? 'YES' : 'NO'}`);
  }
})();
