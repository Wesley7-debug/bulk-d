import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { existsSync, statSync, readFileSync, writeFileSync } from 'fs';

const LANDING_URL = 'https://loadedfiles.net/fdde7e3ed4e67090/Daemons.of.The.Shadow.Realm.S01E01.540p.x265.AAC.[9jaRocks.Com].mkv';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptDownloads: true,
  });
  const page = await context.newPage();

  let mediaUrl = null;
  let mediaCt = null;
  let mediaCl = null;

  const allResponses = [];
  page.on('response', async (response) => {
    const ct = response.headers()['content-type'] || '';
    const cl = response.headers()['content-length'] || '0';
    const disposition = response.headers()['content-disposition'] || '';
    const url = response.url();
    const status = response.status();
    allResponses.push({ url, ct, cl, disposition, status });

    if (ct.includes('video/') || ct.includes('audio/') || ct.includes('application/octet-stream')
        || ct.includes('application/x-matroska') || /attachment/i.test(disposition)
        || ct.includes('application/x-rar') || ct.includes('application/zip')) {
      mediaUrl = url;
      mediaCt = ct;
      mediaCl = cl;
      console.log(`*** MEDIA RESPONSE: status=${status} ct=${ct} cl=${cl} disposition=${disposition}`);
      console.log(`    URL: ${url.substring(0, 300)}`);
    }
  });

  console.log('=== Loading landing page ===');
  await page.goto(LANDING_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  console.log(`URL: ${page.url()}`);
  console.log(`Title: ${await page.title()}`);

  const fullDownloadUrl = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const text = s.textContent;
      if (text && text.includes('downloadUrl')) {
        const match = text.match(/var\s+downloadUrl\s*=\s*['"]([^'"]+)['"]/);
        if (match) return match[1];
        const match2 = text.match(/downloadUrl\s*=\s*['"]([^'"]+)['"]/);
        if (match2) return match2[1];
      }
    }
    return null;
  });
  console.log(`downloadUrl from JS: ${fullDownloadUrl}`);

  const scriptContent = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      if (s.textContent?.includes('downloadButton') || s.textContent?.includes('download')) {
        return s.textContent;
      }
    }
    return null;
  });
  if (scriptContent) {
    console.log(`\nInline download script:\n${scriptContent.substring(0, 3000)}`);
  }

  console.log('\n=== Waiting 25s for cooldown ===');
  await page.waitForTimeout(25000);

  await page.evaluate(() => {
    window.open = () => null;
  });

  console.log('\n=== Setting up download listener, then clicking ONCE ===');
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(e => {
    console.log(`Download event timeout: ${e.message.substring(0, 80)}`);
    return null;
  });

  await page.click('#downloadButton').catch(e => {
    console.log(`Click error: ${e.message.substring(0, 80)}`);
  });
  console.log('Clicked downloadButton ONCE — NOT clicking again');

  await page.waitForTimeout(3000);

  const postClickUrl = page.url();
  console.log(`\nURL after click: ${postClickUrl}`);
  if (postClickUrl !== LANDING_URL) {
    console.log('URL changed after click — this is the resolved file URL');
    const parsedUrl = new URL(postClickUrl);
    console.log(`  Hostname: ${parsedUrl.hostname}`);
    console.log(`  Pathname: ${parsedUrl.pathname}`);
  }

  console.log('\n=== Waiting for download event (30s timeout) ===');
  const download = await downloadPromise;

  if (download) {
    const downloadUrl = download.url();
    const suggestedFilename = download.suggestedFilename();
    console.log(`\n*** DOWNLOAD EVENT FIRED ***`);
    console.log(`  URL: ${downloadUrl}`);
    console.log(`  Suggested filename: ${suggestedFilename}`);

    const savePath = `test-fixtures/downloaded_${suggestedFilename || 'file.mkv'}`;
    await download.saveAs(savePath);
    console.log(`  Saved to: ${savePath}`);

    const stat = statSync(savePath);
    console.log(`  File size: ${stat.size} bytes (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

    const buf = readFileSync(savePath);
    const first16 = buf.subarray(0, 16).toString('hex');
    const first64 = buf.subarray(0, 64).toString('hex');
    console.log(`  First 16 bytes (hex): ${first16}`);
    console.log(`  First 64 bytes (hex): ${first64}`);
    console.log(`  MKV magic (1a45dfa3): ${first16.startsWith('1a45dfa3') ? 'YES' : 'NO'}`);
    console.log(`  MP4 magic (ftyp): ${first16.substring(4, 8) === '66747970' ? 'YES' : 'NO'}`);
    console.log(`  Expected size ~63MB: ${stat.size > 50_000_000 && stat.size < 80_000_000 ? 'YES' : 'NO — check size'}`);

    try {
      const ffprobeOut = execSync(`ffprobe -v error -show_format -show_streams "${savePath}" 2>&1`, { timeout: 15000 }).toString();
      console.log(`\n  ffprobe output (first 2000 chars):`);
      console.log(ffprobeOut.substring(0, 2000));
    } catch (e) {
      console.log(`  ffprobe error: ${e.message.message?.substring(0, 200) || e.message.substring(0, 200)}`);
    }

  } else {
    console.log('\n*** No download event fired — entering fallback path ***');
    console.log('NOTE: This is expected if the browser handles the response as a download');
    console.log('but the download event was missed. Checking post-click URL via HTTP GET.\n');

    if (postClickUrl !== LANDING_URL) {
      console.log(`=== FALLBACK: context.request.get() to post-click URL ===`);
      console.log(`URL: ${postClickUrl}`);

      try {
        const apiResponse = await context.request.get(postClickUrl, {
          timeout: 60000,
        });

        const headers = apiResponse.headers();
        console.log(`Status: ${apiResponse.status()}`);
        console.log(`Content-Type: ${headers['content-type'] || 'none'}`);
        console.log(`Content-Length: ${headers['content-length'] || 'none'}`);
        console.log(`Content-Disposition: ${headers['content-disposition'] || 'none'}`);

        const ct = headers['content-type'] || '';
        const disposition = headers['content-disposition'] || '';
        const isMedia = ct.includes('video') || ct.includes('audio') || ct.includes('octet')
          || ct.includes('x-matroska') || /attachment/i.test(disposition);

        if (isMedia) {
          const body = await apiResponse.body();
          const first16 = body.subarray(0, 16).toString('hex');
          const first64 = body.subarray(0, 64).toString('hex');
          console.log(`\n  Body size: ${body.length} bytes (${(body.length / 1024 / 1024).toFixed(2)} MB)`);
          console.log(`  First 16 bytes (hex): ${first16}`);
          console.log(`  First 64 bytes (hex): ${first64}`);
          console.log(`  MKV magic: ${first16.startsWith('1a45dfa3') ? 'YES' : 'NO'}`);
          console.log(`  MP4 magic: ${first16.substring(4, 8) === '66747970' ? 'YES' : 'NO'}`);

          const savePath = 'test-fixtures/downloaded_fallback.mkv';
          writeFileSync(savePath, body);
          console.log(`  Saved to: ${savePath}`);

          try {
            const ffprobeOut = execSync(`ffprobe -v error -show_format -show_streams "${savePath}" 2>&1`, { timeout: 15000 }).toString();
            console.log(`\n  ffprobe output (first 2000 chars):`);
            console.log(ffprobeOut.substring(0, 2000));
          } catch (e) {
            console.log(`  ffprobe error: ${e.message.message?.substring(0, 200) || e.message.substring(0, 200)}`);
          }
        } else {
          console.log('Response is not media — dumping first 500 bytes of body as text:');
          const body = await apiResponse.body();
          console.log(body.subarray(0, 500).toString('utf-8'));
        }
      } catch (e) {
        console.log(`Fallback request error: ${e.message.substring(0, 200)}`);
      }
    } else {
      console.log('Post-click URL is same as landing URL — no resolved URL to try.');
    }

    if (!mediaUrl && postClickUrl !== LANDING_URL) {
      console.log('\n=== Trying browser-context fetch with credentials ===');
      try {
        const fetchResp = await page.evaluate(async (url) => {
          const resp = await fetch(url, { credentials: 'include' });
          return {
            status: resp.status,
            contentType: resp.headers.get('content-type'),
            contentLength: resp.headers.get('content-length'),
            contentDisposition: resp.headers.get('content-disposition'),
          };
        }, postClickUrl);
        console.log(`Fetch result: ${JSON.stringify(fetchResp)}`);
      } catch (e) {
        console.log(`Fetch error: ${e.message.substring(0, 100)}`);
      }
    }
  }

  console.log('\n=== ALL CAPTURED RESPONSES ===');
  for (const r of allResponses) {
    if (r.ct.includes('video') || r.ct.includes('audio') || r.ct.includes('octet')
        || r.ct.includes('x-matroska') || /attachment/i.test(r.disposition)) {
      console.log(`  [${r.status}] MEDIA: ${r.ct} cl=${r.cl} url=${r.url.substring(0, 150)}`);
    }
  }

  console.log('\n=== SUMMARY ===');
  if (mediaUrl) {
    console.log(`Media URL: ${mediaUrl}`);
    console.log(`Content-Type: ${mediaCt}`);
    console.log(`Content-Length: ${mediaCl}`);
  } else {
    console.log('No media response captured via response listener');
    console.log(`Post-click URL: ${page.url()}`);
  }

  await browser.close();
})();
