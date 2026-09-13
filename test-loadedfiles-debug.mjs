import { chromium } from 'playwright';

const LANDING_URL = 'https://loadedfiles.net/fdde7e3ed4e67090/Daemons.of.The.Shadow.Realm.S01E01.540p.x265.AAC.[9jaRocks.Com].mkv';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptDownloads: true,
  });
  const page = await context.newPage();

  const allResponses = [];
  page.on('response', async (response) => {
    const ct = response.headers()['content-type'] || '';
    const cl = response.headers()['content-length'] || '0';
    const disposition = response.headers()['content-disposition'] || '';
    const url = response.url();
    const status = response.status();
    const location = response.headers()['location'] || '';
    allResponses.push({ url, ct, cl, disposition, status, location });
    console.log(`  [${status}] ${url.substring(0, 120)} ct=${ct} cl=${cl} disp=${disposition.substring(0, 60)} loc=${location.substring(0, 120)}`);
  });

  console.log('=== Step 1: Load landing page ===');
  await page.goto(LANDING_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log(`URL: ${page.url()}`);

  // Extract the downloadUrl (the pt= endpoint)
  const ptUrl = await page.evaluate(() => {
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
  console.log(`\nExtracted pt= URL: ${ptUrl}`);

  // Check button state
  const buttonState = await page.evaluate(() => {
    const btn = document.getElementById('downloadButton');
    return {
      exists: !!btn,
      disabled: btn?.disabled,
      text: btn?.textContent?.trim(),
      visible: btn?.offsetParent !== null,
    };
  });
  console.log(`Button state: ${JSON.stringify(buttonState)}`);

  if (ptUrl) {
    console.log('\n=== Step 2: Try direct click via page.evaluate (force JS handler) ===');
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(e => {
      console.log(`Download event: ${e.message.substring(0, 80)}`);
      return null;
    });

    await page.evaluate(() => {
      const btn = document.getElementById('downloadButton');
      if (btn) btn.click();
    });
    console.log('Called btn.click() via evaluate');

    await page.waitForTimeout(5000);
    console.log(`URL after evaluate click: ${page.url()}`);

    const dl = await downloadPromise;
    if (dl) {
      console.log(`*** Download fired! URL: ${dl.url()}`);
    } else {
      console.log('No download event from evaluate click');
    }

    console.log('\n=== Step 3: Direct navigation to pt= URL ===');
    const downloadPromise2 = page.waitForEvent('download', { timeout: 15000 }).catch(e => {
      console.log(`Download event 2: ${e.message.substring(0, 80)}`);
      return null;
    });

    const response = await page.goto(ptUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      console.log(`Nav error: ${e.message.substring(0, 100)}`);
      return null;
    });

    if (response) {
      const headers = response.headers();
      console.log(`\nDirect nav response:`);
      console.log(`  Status: ${response.status()}`);
      console.log(`  Content-Type: ${headers['content-type'] || 'none'}`);
      console.log(`  Content-Length: ${headers['content-length'] || 'none'}`);
      console.log(`  Content-Disposition: ${headers['content-disposition'] || 'none'}`);
      console.log(`  Location: ${headers['location'] || 'none'}`);
      console.log(`  Final URL: ${page.url()}`);

      if (headers['content-type']?.includes('video') || headers['content-type']?.includes('octet')
          || /attachment/i.test(headers['content-disposition'] || '')) {
        const body = await response.body();
        console.log(`  Body size: ${body.length} bytes`);
        console.log(`  First 16 hex: ${body.subarray(0, 16).toString('hex')}`);
      }
    }

    const dl2 = await downloadPromise2;
    if (dl2) {
      console.log(`*** Download event 2 fired! URL: ${dl2.url()} filename: ${dl2.suggestedFilename()}`);
    } else {
      console.log('No download event from direct navigation');
    }

    console.log(`\nURL after pt= nav: ${page.url()}`);

    if (page.url().includes('text/html') || page.url() === ptUrl) {
      const bodyText = await page.evaluate(() => document.body?.textContent?.replace(/\s+/g, ' ')?.substring(0, 2000));
      console.log(`Page body: ${bodyText?.substring(0, 500)}`);
    }
  }

  console.log('\n=== Step 4: context.request.get() to pt= URL ===');
  if (ptUrl) {
    const apiResp = await context.request.get(ptUrl, { timeout: 30000 });
    const apiHeaders = apiResp.headers();
    console.log(`Status: ${apiResp.status()}`);
    console.log(`Content-Type: ${apiHeaders['content-type'] || 'none'}`);
    console.log(`Content-Length: ${apiHeaders['content-length'] || 'none'}`);
    console.log(`Content-Disposition: ${apiHeaders['content-disposition'] || 'none'}`);

    const apiCt = apiHeaders['content-type'] || '';
    if (apiCt.includes('video') || apiCt.includes('octet') || apiCt.includes('x-matroska')
        || /attachment/i.test(apiHeaders['content-disposition'] || '')) {
      const body = await apiResp.body();
      console.log(`  Body size: ${body.length} bytes (${(body.length / 1024 / 1024).toFixed(2)} MB)`);
      console.log(`  First 16 hex: ${body.subarray(0, 16).toString('hex')}`);
      console.log(`  MKV magic: ${body.subarray(0, 4).toString('hex') === '1a45dfa3' ? 'YES' : 'NO'}`);
      console.log(`  First 64 hex: ${body.subarray(0, 64).toString('hex')}`);
    } else {
      const text = (await apiResp.body()).subarray(0, 2000).toString('utf-8');
      console.log(`Response body (first 2000 chars):\n${text}`);
    }
  }

  console.log('\n=== ALL RESPONSES ===');
  for (const r of allResponses) {
    if (!r.url.match(/\.(css|js|png|jpg|jpeg|gif|svg|woff|ico|map|ttf|eot)(\?|$)/i)) {
      console.log(`[${r.status}] ${r.ct.substring(0, 40)} cl=${r.cl} disp=${r.disposition.substring(0, 40)} url=${r.url.substring(0, 150)}`);
    }
  }

  await browser.close();
})();
