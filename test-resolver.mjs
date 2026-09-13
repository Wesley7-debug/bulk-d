import { chromium } from 'playwright';

const LANDING_URL = 'https://9jarocks.net/videodownload/daemons-of-the-shadow-realm-season-1-anime-id384308.html';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  const mediaMimes = ['video/', 'audio/', 'application/octet-stream', 'application/zip', 'application/x-rar', 'application/x-7z'];
  const allResponses = [];
  page.on('response', async (response) => {
    const ct = response.headers()['content-type'] || '';
    const cl = response.headers()['content-length'] || '0';
    const status = response.status();
    const url = response.url();
    const disposition = response.headers()['content-disposition'] || '';
    allResponses.push({ url: url.substring(0, 200), ct, cl, status, disposition: disposition.substring(0, 100) });
    if (mediaMimes.some(m => ct.includes(m)) || /attachment/i.test(disposition)) {
      console.log(`*** MEDIA: status=${status} ct=${ct} cl=${cl} url=${url.substring(0, 200)} disposition=${disposition.substring(0, 80)}`);
    }
  });

  console.log('=== Loading page ===');
  try {
    await page.goto(LANDING_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.log(`Nav timeout: ${e.message.substring(0, 100)}`);
  }

  await page.waitForTimeout(5000);

  console.log(`Title: ${await page.title()}`);
  console.log(`URL: ${page.url()}`);

  // Find download links
  const links = await page.$$eval('a[href]', els => els.map(el => ({
    text: el.textContent?.trim()?.substring(0, 100) || '',
    href: el.href || '',
    cls: el.className?.substring(0, 80) || '',
  })));

  console.log(`\n=== All links (${links.length}) ===`);
  for (const l of links) {
    if (l.text.length > 0 && l.text.length < 100) {
      console.log(`"${l.text}" -> ${l.href.substring(0, 160)} class="${l.cls.substring(0, 40)}"`);
    }
  }

  // Look for download buttons / download-related elements
  const downloadElements = links.filter(l => /download|get.*link|free|grab|unlock|click here/i.test(l.text) || /download/i.test(l.cls));
  console.log(`\n=== Download CTAs (${downloadElements.length}) ===`);
  for (const d of downloadElements) {
    console.log(`"${d.text}" -> ${d.href.substring(0, 200)} class="${d.cls}"`);
  }

  // Look for episode-specific links
  const epLinks = links.filter(l => /s01e01|ep.*01|episode.*1/i.test(l.text + ' ' + l.href));
  console.log(`\n=== Episode 1 specific links (${epLinks.length}) ===`);
  for (const e of epLinks) {
    console.log(`"${e.text}" -> ${e.href.substring(0, 200)}`);
  }

  // Check for video/iframe/source elements
  const html = await page.content();
  const videos = html.match(/<video[^>]*src=["'][^"']*["'][^>]*>/gi) || [];
  const sources = html.match(/<source[^>]*src=["'][^"']*["'][^>]*>/gi) || [];
  const iframes = html.match(/<iframe[^>]*src=["'][^"']*["'][^>]*>/gi) || [];
  console.log(`\n=== Media elements ===`);
  console.log(`Videos: ${videos.length}`);
  for (const v of videos) console.log(`  ${v.substring(0, 200)}`);
  console.log(`Sources: ${sources.length}`);
  for (const s of sources) console.log(`  ${s.substring(0, 200)}`);
  console.log(`Iframes: ${iframes.length}`);
  for (const i of iframes) console.log(`  ${i.substring(0, 200)}`);

  // Body text preview
  const bodyText = await page.$eval('body', el => el.textContent?.replace(/\s+/g, ' ')?.substring(0, 5000));
  console.log(`\n=== Body text (2000 chars) ===`);
  console.log(bodyText?.substring(0, 2000));

  // Non-asset network responses
  console.log(`\n=== Non-static network responses ===`);
  for (const r of allResponses.filter(r => !r.url.match(/\.(css|js|png|jpg|jpeg|gif|svg|woff|ico|map|ttf|eot)(\?|$)/i))) {
    console.log(`[${r.status}] ${r.ct.substring(0, 50)} cl=${r.cl} url=${r.url.substring(0, 160)}`);
  }

  await browser.close();
  console.log('\n=== Done ===');
})();
