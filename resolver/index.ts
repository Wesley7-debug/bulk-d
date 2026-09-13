import * as cheerio from "cheerio";
import { HostLink, MediaResource, DiscoveredFile, FileType, UserIntent } from "../types";
import { normalizeUrl } from "../lib/utils";
import {
  HOST_FILE_SIZE_PATTERN,
  HOST_FILENAME_PATTERN,
  DOWNLOAD_CTA_PATTERNS,
  JS_VOID_HREF,
  HASH_ONLY_HREF,
  RESOLVE_MAX_HOPS,
  RESOLVE_TIMEOUT_MS,
  HEADLESS_TIMEOUT_MS,
  COOLDOWN_MAX_WAIT_MS,
  DOWNLOAD_EVENT_TIMEOUT_MS,
  TITLE_MATCH_THRESHOLD,
} from "../lib/constants";
import { classifyPage, detectHostLandingPage } from "./page-classifier";
import { logger } from "../lib/logger";

const MEDIA_EXT_REGEX = /\.(mp4|webm|mkv|avi|mov|wmv|flv|webm|mp3|wav|flac|aac|ogg|m4a|zip|rar|7z|pdf)(?:\?[^"'\s]*)?$/i;

let chromium: typeof import("playwright")["chromium"] | null = null;
async function getChromium() {
  if (!chromium) {
    try {
      const pw = await import("playwright");
      chromium = pw.chromium;
    } catch {
      return null;
    }
  }
  return chromium;
}

const TITLE_STOP_WORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "are", "was",
  "not", "but", "what", "all", "were", "been", "has", "had", "its",
  "can", "may", "will", "shall", "who", "how", "than", "too", "very",
  "just", "also", "over", "such", "into", "some", "them", "each",
  "then", "more", "most", "when", "your", "our", "their", "any",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !TITLE_STOP_WORDS.has(t));
}

function fuzzyTitleMatch(title: string, text: string): number {
  const titleTokens = tokenize(title);
  if (titleTokens.length === 0) return 0;
  const textCombined = tokenize(text).join(" ");
  let matchCount = 0;
  for (const token of titleTokens) {
    if (textCombined.includes(token)) matchCount++;
  }
  return matchCount / titleTokens.length;
}

function strictTitleMatch(title: string, text: string): number {
  const titleTokens = tokenize(title);
  if (titleTokens.length === 0) return 0;
  const textTokens = tokenize(text);
  if (textTokens.length === 0) return 0;

  const titleSet = new Set(titleTokens);
  const textSet = new Set(textTokens);

  let matchCount = 0;
  for (const token of titleSet) {
    if (textSet.has(token)) matchCount++;
  }

  const uniqueTitleCount = titleSet.size;
  const uniqueTextCount = textSet.size;
  if (uniqueTitleCount === 0) return 0;

  const precision = matchCount / Math.max(uniqueTextCount, 1);
  const recall = matchCount / uniqueTitleCount;

  if (recall < 0.5) return 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return f1;
}

export function isEmbedUrl(url: string): boolean {
  const lower = url.toLowerCase();

  if (/youtube\.com\/embed\//.test(lower)) return true;
  if (/youtube\.com\/shorts\//.test(lower)) return true;
  if (/youtu\.be\//.test(lower)) return true;
  if (/youtube\.com\/watch\?.*v=/.test(lower)) return true;
  if (/vimeo\.com\/\d+/.test(lower) && !lower.includes("/video/")) return true;
  if (/dailymotion\.com\/embed\//.test(lower)) return true;
  if (/facebook\.com\/.*\/videos\//.test(lower)) return true;
  if (/twitch\.tv\/videos\//.test(lower)) return true;
  if (/streamable\.com\//.test(lower)) return true;
  if (/instagram\.com\/.*\/(reel|p)\//.test(lower)) return true;
  if (/tiktok\.com\/@.*\/video\//.test(lower)) return true;
  if (/twitter\.com\/.*\/status\//.test(lower)) return true;
  if (/x\.com\/.*\/status\//.test(lower)) return true;

  const embedIndicators = [
    /^https?:\/\/[^\s]*\/embed\/[^\s]+/i,
    /^https?:\/\/[^\s]*\?.*\b(video|embed|player)=/i,
  ];
  for (const pattern of embedIndicators) {
    if (pattern.test(url)) return true;
  }

  return false;
}

export function isTrailerUrl(url: string, text: string): boolean {
  const combined = `${url} ${text}`.toLowerCase();
  return /\btrailer\b/.test(combined) && !/\b(full|episode|ep\d+|season)\b/.test(combined);
}

export function detectSeasonPack(text: string): boolean {
  const patterns = [
    /\b(season|complete|full)\b.*\b\d+\s*(?:to|[-–])\s*\d+/i,
    /\b\d+\s*(?:to|[-–])\s*\d+\b.*\b(season|eps?|episodes?)\b/i,
    /\b(episodes?|eps?)\s*\d+\s*(?:to|[-–])\s*\d+/i,
    /\bs\d+\s*(?:to|[-–])\s*s?\d+/i,
    /\ball\s+\d+\s+episodes?\b/i,
    /\bcomplete\s+series\b/i,
    /\bbatch\b.*\bdownload\b/i,
    /\bpack\b.*\b(download|season|series)\b/i,
    /\b\d+\s*episodes?\b.*\bpack\b/i,
  ];
  return patterns.some((p) => p.test(text));
}

export function extractEpisodeRangeFromText(text: string): { start: number; end: number } | null {
  const patterns = [
    /(?:season|ep(?:isodes?)?)\s*(\d+)\s*(?:to|[-–])\s*(\d+)/i,
    /\bs(\d+)[-\s]*s(\d+)/i,
    /\bep\s*(\d+)\s*(?:to|[-–])\s*(\d+)/i,
    /\b(\d+)\s*(?:to|[-–])\s*(\d+)\s*episodes?\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const start = parseInt(match[1]);
      const end = parseInt(match[2]);
      if (start > 0 && end > start && end - start < 100) {
        return { start, end };
      }
    }
  }
  return null;
}

export function filterLinksByTitle(
  links: Array<{ href: string; text: string }>,
  intent: UserIntent,
  jobId: string,
  sourceLabel: string
): Array<{ href: string; text: string; titleScore: number }> {
  const targetTitle = intent.requestedTitle || intent.derivedTitle || "";
  if (!targetTitle) {
    return links.map((l) => ({ ...l, titleScore: 1 }));
  }

  const kept: Array<{ href: string; text: string; titleScore: number }> = [];
  const discarded: Array<{ href: string; text: string; reason: string }> = [];

  for (const link of links) {
    if (isEmbedUrl(link.href)) {
      discarded.push({
        href: link.href,
        text: link.text.substring(0, 60),
        reason: "embed_url_excluded",
      });
      continue;
    }

    if (isTrailerUrl(link.href, link.text)) {
      discarded.push({
        href: link.href,
        text: link.text.substring(0, 60),
        reason: "trailer_excluded",
      });
      continue;
    }

    const strictScore = strictTitleMatch(targetTitle, `${link.href} ${link.text}`);
    const fuzzyScore = fuzzyTitleMatch(targetTitle, link.href);
    const fuzzyTextScore = fuzzyTitleMatch(targetTitle, link.text);
    const score = Math.max(strictScore, Math.max(fuzzyScore, fuzzyTextScore));

    if (strictScore > 0 || score >= TITLE_MATCH_THRESHOLD) {
      kept.push({ ...link, titleScore: score });
    } else {
      discarded.push({
        href: link.href,
        text: link.text.substring(0, 60),
        reason: `title_match=${score.toFixed(2)} strict=${strictScore.toFixed(2)} < ${TITLE_MATCH_THRESHOLD}`,
      });
    }
  }

  if (discarded.length > 0) {
    logger.log(jobId, "TITLE_FILTER", `source=${sourceLabel} kept=${kept.length} discarded=${discarded.length}`, {
      discardedSample: discarded.slice(0, 5),
    });
  }

  return kept;
}

export function detectHostLinks(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  jobId: string
): HostLink[] {
  const hostLinks: HostLink[] = [];
  const allLinks: Array<{ href: string; text: string }> = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim();
    allLinks.push({ href, text });
  });

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const hlp = detectHostLandingPage(pageUrl, $.html());

  if (hlp.isHostLandingPage) {
    const filenameMatch = bodyText.match(HOST_FILENAME_PATTERN);
    const sizeMatch = bodyText.match(HOST_FILE_SIZE_PATTERN);

    const existing = new Set(hostLinks.map((h) => h.landingUrl));
    if (!existing.has(pageUrl)) {
      hostLinks.push({
        landingUrl: pageUrl,
        filename: filenameMatch ? filenameMatch[0] : null,
        fileSize: sizeMatch ? sizeMatch[0] : null,
        confidence: hlp.confidence,
        sourcePage: pageUrl,
      });
      logger.log(jobId, "HOST_DETECT", `host_landing_page=${pageUrl} confidence=${hlp.confidence}`, {
        filename: filenameMatch ? filenameMatch[0] : null,
        signals: hlp.signals.slice(0, 5),
      });
    }
  }

  for (const link of allLinks) {
    let resolved: string;
    try {
      resolved = normalizeUrl(link.href, pageUrl);
    } catch {
      continue;
    }

    const linkHost = new URL(resolved).hostname.toLowerCase();
    const pageHost = new URL(pageUrl).hostname.toLowerCase();
    if (linkHost === pageHost) continue;

    const linkHlp = (() => {
      const linkText = link.text.toLowerCase().trim();
      const isDownloadCTA = DOWNLOAD_CTA_PATTERNS.some((p) => p.test(linkText))
        || (linkText.includes("download") && linkText.length < 30);
      const isVague = JS_VOID_HREF.test(link.href) || HASH_ONLY_HREF.test(link.href);
      return isDownloadCTA || isVague;
    })();

    if (linkHlp) {
      const existing = new Set(hostLinks.map((h) => h.landingUrl));
      if (!existing.has(resolved)) {
        hostLinks.push({
          landingUrl: resolved,
          filename: null,
          fileSize: null,
          confidence: 0.5,
          sourcePage: pageUrl,
        });
        logger.log(jobId, "HOST_DETECT", `cross_domain_link=${resolved}`, {
          linkText: link.text.substring(0, 50),
        });
      }
    }
  }

  return hostLinks;
}

export async function resolveStatic(
  url: string,
  jobId: string
): Promise<MediaResource | null> {
  const resolutionLog: string[] = [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!response.ok) {
      resolutionLog.push(`RESOLVE_STATIC status=failed http_status=${response.status}`);
      logger.log(jobId, "RESOLVE", `strategy=direct_typed_link status=failed http_status=${response.status}`);
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    const contentLength = parseInt(response.headers.get("content-length") || "0") || undefined;
    const contentDisposition = response.headers.get("content-disposition") || "";

    if (contentType.includes("video/") || contentType.includes("audio/")
        || contentType.includes("application/octet-stream")
        || contentType.includes("application/zip")
        || contentType.includes("application/x-rar")) {
      const filename = extractFilenameFromDisposition(contentDisposition)
        || extractFilenameFromUrl(url);
      resolutionLog.push(`RESOLVE_STATIC strategy=direct_typed_link status=ok content_type=${contentType}`);
      logger.log(jobId, "RESOLVE", `strategy=direct_typed_link status=ok url=${url}`, {
        contentType,
        filename,
      });
      return {
        url: response.url || url,
        filename,
        fileType: guessFileTypeFromMime(contentType),
        mimeType: contentType,
        size: contentLength,
        resolutionStrategy: "static",
        resolutionLog,
      };
    }

    if (contentType.includes("text/html")) {
      let htmlBody = "";
      try {
        const getController = new AbortController();
        const getTimeout = setTimeout(() => getController.abort(), RESOLVE_TIMEOUT_MS);
        const getResp = await fetch(url, {
          signal: getController.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          redirect: "follow",
        });
        clearTimeout(getTimeout);
        htmlBody = await getResp.text();
      } catch {
        return null;
      }
      const $ = cheerio.load(htmlBody);

      const metaRefresh = $('meta[http-equiv="refresh"]').attr("content");
      if (metaRefresh) {
        const urlMatch = metaRefresh.match(/url=(.+)/i);
        if (urlMatch) {
          let refreshUrl = urlMatch[1].trim();
          try { refreshUrl = new URL(refreshUrl, url).href; } catch { /* use as-is */ }
          resolutionLog.push(`RESOLVE_STATIC strategy=meta_refresh hop=1 target=${refreshUrl}`);
          logger.log(jobId, "RESOLVE", `strategy=meta_refresh hop=1 target=${refreshUrl}`);
          const nested = await resolveStatic(refreshUrl, jobId);
          if (nested) {
            nested.resolutionLog.unshift(...resolutionLog);
            return nested;
          }
        }
      }

      const ogVideo = $('meta[property="og:video"]').attr("content")
        || $('meta[property="og:video:url"]').attr("content")
        || $('meta[property="og:video:secure_url"]').attr("content");
      if (ogVideo) {
        let videoUrl = ogVideo;
        try { videoUrl = new URL(ogVideo, url).href; } catch { /* use as-is */ }
        resolutionLog.push(`RESOLVE_STATIC strategy=og_video url=${videoUrl}`);
        logger.log(jobId, "RESOLVE", `strategy=og_video url=${videoUrl}`);
        return {
          url: videoUrl,
          filename: extractFilenameFromUrl(videoUrl),
          fileType: "video",
          mimeType: "video/mp4",
          resolutionStrategy: "static",
          resolutionLog,
        };
      }
    }

    resolutionLog.push(`RESOLVE_STATIC strategy=direct_typed_link status=not_media content_type=${contentType}`);
    logger.log(jobId, "RESOLVE", `strategy=direct_typed_link status=not_media content_type=${contentType}`);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    resolutionLog.push(`RESOLVE_STATIC strategy=direct_typed_link status=error reason=${msg}`);
    logger.log(jobId, "RESOLVE", `strategy=direct_typed_link status=error reason=${msg}`);
    return null;
  }
}

async function resolveViaHeadless(
  landingUrl: string,
  jobId: string
): Promise<MediaResource | null> {
  const pw = await getChromium();
  if (!pw) {
    logger.log(jobId, "RESOLVE", "strategy=headless status=skipped reason=playwright_not_available");
    return null;
  }

  const resolutionLog: string[] = [];
  let browser = null;

  try {
    browser = await pw.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      javaScriptEnabled: true,
      acceptDownloads: true,
    });

    const page = await context.newPage();

    let mediaUrl: string | null = null;
    let mediaContentType: string | null = null;
    let mediaContentLength: number | null = null;
    let hopCount = 0;

    const mediaMimes = [
      "video/", "audio/", "application/octet-stream",
      "application/zip", "application/x-rar", "application/x-7z",
      "application/x-tar", "application/gzip",
      "application/vnd.rar", "application/x-7z-compressed",
    ];

    const isMediaResponse = (ct: string, disposition: string): boolean => {
      if (!ct) return false;
      // application/octet-stream is too generic (fonts, blobs) — only count if also has attachment disposition
      if (ct.includes("application/octet-stream")) {
        return /attachment/i.test(disposition);
      }
      return mediaMimes.some((m) => ct.includes(m));
    };

    const capturedResponses: Array<{ url: string; contentType: string; status: number; contentLength: number }> = [];

    page.on("response", async (response) => {
      const ct = response.headers()["content-type"] || "";
      const cl = parseInt(response.headers()["content-length"] || "0") || 0;
      const status = response.status();
      const rUrl = response.url();

      capturedResponses.push({ url: rUrl, contentType: ct, status, contentLength: cl });

      if (mediaUrl) return;

      const disposition = response.headers()["content-disposition"] || "";
      const hasAttachmentDisposition = /attachment/i.test(disposition);

      if ((isMediaResponse(ct, disposition) || hasAttachmentDisposition) && status >= 200 && status < 400) {
        mediaUrl = rUrl;
        mediaContentType = ct;
        mediaContentLength = cl || null;
        logger.log(jobId, "RESOLVE", `strategy=headless media_detected url=${rUrl.substring(0, 150)} ct=${ct} cl=${cl} disposition=${disposition.substring(0, 80)}`);
      }
    });

    let popupUrl: string | null = null;
    context.on("page", async (newPage) => {
      try {
        await newPage.waitForLoadState("domcontentloaded", { timeout: HEADLESS_TIMEOUT_MS }).catch(() => {});
        popupUrl = newPage.url();
        logger.log(jobId, "RESOLVE", `strategy=headless popup_detected url=${popupUrl}`);
      } catch { /* ignore */ }
    });

    // Block popups
    await page.evaluate(() => { window.open = () => null; }).catch(() => {});

    resolutionLog.push(`RESOLVE strategy=headless hop=0 loading=${landingUrl}`);
    logger.log(jobId, "RESOLVE", `strategy=headless hop=0 loading=${landingUrl}`);

    await page.goto(landingUrl, {
      waitUntil: "networkidle",
      timeout: HEADLESS_TIMEOUT_MS,
    });

    await page.waitForTimeout(2000);

    // If media appeared on initial load, return it
    if (mediaUrl) {
      hopCount = 1;
      resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} status=ok media_url=${mediaUrl} ct=${mediaContentType}`);
      logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} status=ok media_url=${mediaUrl}`, {
        contentType: mediaContentType,
        contentLength: mediaContentLength,
      });
      return {
        url: mediaUrl,
        filename: extractFilenameFromUrl(mediaUrl),
        fileType: guessFileTypeFromMime(mediaContentType || ""),
        mimeType: mediaContentType || "video/mp4",
        size: mediaContentLength || undefined,
        resolutionStrategy: "headless",
        resolutionLog,
      };
    }

    // ===== COOLDOWN DETECTION =====
    // Check for countdown/timer elements and wait for them
    const hasCooldown = await page.evaluate(() => {
      const bodyText = document.body?.textContent || "";
      return /\bseconds?\b|\bcountdown\b|\bplease wait\b|\bloading\b|\bgenerating\b|\bwait\b/i.test(bodyText)
        || document.querySelectorAll('[class*="countdown"], [id*="countdown"], [class*="timer"]').length > 0;
    }).catch(() => false);

    if (hasCooldown) {
      logger.log(jobId, "RESOLVE", "strategy=headless cooldown_detected waiting...");
      resolutionLog.push("RESOLVE strategy=headless cooldown_detected waiting");

      // Wait for cooldown (poll button state, max 30s)
      for (let i = 0; i < 15; i++) {
        await page.waitForTimeout(2000);
        const disabled = await page.evaluate(() => {
          const btn = document.getElementById("downloadButton") as HTMLButtonElement | null;
          return btn?.disabled ?? null;
        }).catch(() => null);
        if (disabled === false || disabled === null) {
          logger.log(jobId, "RESOLVE", `strategy=headless cooldown_resolved after ${i * 2}s`);
          resolutionLog.push(`RESOLVE strategy=headless cooldown_resolved after ${i * 2}s`);
          break;
        }
      }
    }

    // ===== CTA CLICKING WITH DOWNLOAD EVENT RACING =====
    const clicked = await clickDownloadCta(page, landingUrl, jobId, resolutionLog);
    if (!clicked) {
      resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} status=failed reason=no_download_cta`);
      logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} status=failed reason=no_download_cta`);
      return null;
    }
    hopCount++;

    // ===== RACE: download event vs navigation vs media response =====
    const downloadPromise = page.waitForEvent("download", { timeout: DOWNLOAD_EVENT_TIMEOUT_MS }).catch(() => null);

    // Wait a moment for the click to take effect
    await page.waitForTimeout(1000);

    // Wait for either download event or navigation, whichever comes first
    const download = await downloadPromise;

    if (download) {
      // Download event fired — this is the real file URL
      const cdnUrl = download.url();
      hopCount++;
      resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} status=ok download_event_url=${cdnUrl.substring(0, 150)}`);
      logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} status=ok download_event_url=${cdnUrl.substring(0, 150)}`);

      // The download event URL is the CDN URL — extract filename from it
      return {
        url: cdnUrl,
        filename: download.suggestedFilename() || extractFilenameFromUrl(cdnUrl),
        fileType: guessFileTypeFromUrl(cdnUrl),
        mimeType: guessMimeTypeFromUrl(cdnUrl),
        resolutionStrategy: "headless",
        resolutionLog,
      };
    }

    // No download event — check if media appeared via response listener
    if (mediaUrl) {
      hopCount++;
      resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} status=ok media_url=${mediaUrl} ct=${mediaContentType}`);
      logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} status=ok media_url=${mediaUrl}`, {
        contentType: mediaContentType,
        contentLength: mediaContentLength,
      });
      return {
        url: mediaUrl,
        filename: extractFilenameFromUrl(mediaUrl),
        fileType: guessFileTypeFromMime(mediaContentType || ""),
        mimeType: mediaContentType || "video/mp4",
        size: mediaContentLength || undefined,
        resolutionStrategy: "headless",
        resolutionLog,
      };
    }

    // Check if URL changed (page navigated to a new page)
    const currentUrl = page.url();
    if (currentUrl !== landingUrl) {
      hopCount++;
      resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} redirected_to=${currentUrl.substring(0, 150)}`);
      logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} redirected_to=${currentUrl.substring(0, 150)}`);

      // Check if this new page has ANOTHER download CTA (multi-hop gateway pattern)
      if (hopCount < RESOLVE_MAX_HOPS) {
        // Check for cooldown on the new page
        const hasCooldown2 = await page.evaluate(() => {
          const bodyText = document.body?.textContent || "";
          return /\bseconds?\b|\bcountdown\b|\bplease wait\b/i.test(bodyText);
        }).catch(() => false);

        if (hasCooldown2) {
          logger.log(jobId, "RESOLVE", `strategy=headless cooldown_detected_on_hop_${hopCount}`);
          resolutionLog.push(`RESOLVE strategy=headless cooldown_detected_on_hop_${hopCount}`);
          for (let i = 0; i < 15; i++) {
            await page.waitForTimeout(2000);
            const disabled = await page.evaluate(() => {
              const btn = document.getElementById("downloadButton") as HTMLButtonElement | null;
              return btn?.disabled ?? null;
            }).catch(() => null);
            if (disabled === false || disabled === null) break;
          }
        }

        // Try clicking again on the new page
        const clicked2 = await clickDownloadCta(page, currentUrl, jobId, resolutionLog);
        if (clicked2) {
          hopCount++;
          const download2 = await page.waitForEvent("download", { timeout: DOWNLOAD_EVENT_TIMEOUT_MS }).catch(() => null);
          if (download2) {
            const cdnUrl2 = download2.url();
            resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} status=ok download_event_url=${cdnUrl2.substring(0, 150)}`);
            logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} status=ok download_event_url=${cdnUrl2.substring(0, 150)}`);
            return {
              url: cdnUrl2,
              filename: download2.suggestedFilename() || extractFilenameFromUrl(cdnUrl2),
              fileType: guessFileTypeFromUrl(cdnUrl2),
              mimeType: guessMimeTypeFromUrl(cdnUrl2),
              resolutionStrategy: "headless",
              resolutionLog,
            };
          }
        }
      }
    }

    // ===== FALLBACK: Check captured responses for media =====
    const responseMedia = capturedResponses.find((r) =>
      isMediaResponse(r.contentType) && r.status >= 200 && r.status < 400
    );
    if (responseMedia) {
      hopCount++;
      resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} status=ok captured_response=${responseMedia.url.substring(0, 150)}`);
      logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} status=ok captured_response=${responseMedia.url.substring(0, 150)}`);
      return {
        url: responseMedia.url,
        filename: extractFilenameFromUrl(responseMedia.url),
        fileType: guessFileTypeFromMime(responseMedia.contentType),
        mimeType: responseMedia.contentType,
        size: responseMedia.contentLength || undefined,
        resolutionStrategy: "headless",
        resolutionLog,
      };
    }

    // ===== FALLBACK: Check page HTML for media URLs =====
    if (hopCount < RESOLVE_MAX_HOPS) {
      const finalHtml = await page.content().catch(() => "");
      const $ = cheerio.load(finalHtml);
      const finalBodyText = $("body").text().replace(/\s+/g, " ");

      const mediaInText = finalBodyText.match(
        /https?:\/\/[^\s"'<>]+\.(mp4|webm|mkv|avi|mov|mp3|wav|flac|m4a|zip|rar|7z)(?:\?[^\s"'<>]*)?/gi
      );
      if (mediaInText && mediaInText.length > 0) {
        const foundUrl = mediaInText[0];
        hopCount++;
        resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} status=ok media_in_page=${foundUrl}`);
        logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} status=ok media_in_page=${foundUrl}`);
        return {
          url: foundUrl,
          filename: extractFilenameFromUrl(foundUrl),
          fileType: guessFileTypeFromUrl(foundUrl),
          mimeType: guessMimeTypeFromUrl(foundUrl),
          resolutionStrategy: "headless",
          resolutionLog,
        };
      }

      const ogVideo = $('meta[property="og:video"]').attr("content")
        || $('meta[property="og:video:url"]').attr("content")
        || $('meta[property="og:video:secure_url"]').attr("content");
      if (ogVideo) {
        let videoUrl = ogVideo;
        try { videoUrl = new URL(ogVideo, page.url()).href; } catch { /* use as-is */ }
        hopCount++;
        resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} status=ok og_video=${videoUrl}`);
        logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} status=ok og_video=${videoUrl}`);
        return {
          url: videoUrl,
          filename: extractFilenameFromUrl(videoUrl),
          fileType: "video",
          mimeType: "video/mp4",
          resolutionStrategy: "headless",
          resolutionLog,
        };
      }

      const pageLinks = await page.$$('a[href]');
      for (const link of pageLinks) {
        const href = await link.getAttribute("href") || "";
        if (MEDIA_EXT_REGEX.test(href)) {
          let resolved: string;
          try { resolved = new URL(href, page.url()).href; } catch { continue; }
          hopCount++;
          resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} status=ok link_media=${resolved}`);
          logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} status=ok link_media=${resolved}`);
          return {
            url: resolved,
            filename: extractFilenameFromUrl(resolved),
            fileType: guessFileTypeFromUrl(resolved),
            mimeType: guessMimeTypeFromUrl(resolved),
            resolutionStrategy: "headless",
            resolutionLog,
          };
        }
      }

      if (popupUrl && popupUrl !== page.url()) {
        hopCount++;
        resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} checking_popup=${popupUrl}`);
        logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} checking_popup=${popupUrl}`);

        const popupResult = await resolveStatic(popupUrl, jobId);
        if (popupResult) {
          popupResult.resolutionLog.unshift(...resolutionLog);
          return popupResult;
        }
      }
    }

    resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} status=failed reason=no_media_found`);
    logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} status=failed reason=no_media_found`, {
      capturedResponseCount: capturedResponses.length,
      capturedTypes: capturedResponses.slice(0, 10).map((r) => ({ url: r.url.substring(0, 80), ct: r.contentType, status: r.status })),
    });
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    resolutionLog.push(`RESOLVE strategy=headless status=error reason=${msg}`);
    logger.log(jobId, "RESOLVE", `strategy=headless status=error reason=${msg}`);
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Find and click a download CTA on the current page.
 * Uses page.evaluate() to trigger JS onclick handlers (not just Playwright API clicks).
 * Returns true if a click was attempted.
 */
async function clickDownloadCta(
  page: any,
  pageUrl: string,
  jobId: string,
  resolutionLog: string[]
): Promise<boolean> {
  const allCtas = await page.$$('a, button, [role="button"], input[type="submit"], input[type="button"]');

  for (const el of allCtas) {
    const text = (await el.textContent())?.toLowerCase().trim() || "";
    const href = await el.getAttribute("href") || "";
    const onclick = await el.getAttribute("onclick") || "";
    const dataHref = await el.getAttribute("data-href") || "";
    const className = await el.getAttribute("class") || "";
    const disabled = await el.evaluate((e: any) => e.disabled).catch(() => false);

    if (disabled) continue;

    const isDownload = DOWNLOAD_CTA_PATTERNS.some((p) => p.test(text))
      || (text.includes("download") && text.length < 40)
      || (text.includes("get link") && text.length < 30)
      || (text.includes("click here") && text.length < 30)
      || JS_VOID_HREF.test(href)
      || HASH_ONLY_HREF.test(href)
      || JS_VOID_HREF.test(onclick)
      || MEDIA_EXT_REGEX.test(href)
      || MEDIA_EXT_REGEX.test(dataHref)
      || /download|btn.*download|dl.*btn/i.test(className);

    if (isDownload) {
      // Check data-href first (direct media link)
      if (dataHref && MEDIA_EXT_REGEX.test(dataHref)) {
        let resolved: string;
        try { resolved = new URL(dataHref, pageUrl).href; } catch { resolved = dataHref; }
        resolutionLog.push(`RESOLVE strategy=headless cta_data_href=${resolved.substring(0, 100)}`);
        logger.log(jobId, "RESOLVE", `strategy=headless cta_data_href=${resolved.substring(0, 100)}`);
        // Store the resolved URL on the page for the caller to pick up
        await page.evaluate((url: string) => { (window as any).__mediaHref = url; }, resolved);
        return true;
      }

      // Use evaluate to trigger JS onclick handlers (critical for loadedfiles pattern)
      try {
        await el.evaluate((e: any) => { e.click(); });
        resolutionLog.push(`RESOLVE strategy=headless clicked_cta="${text.substring(0, 40)}"`);
        logger.log(jobId, "RESOLVE", `strategy=headless clicked_cta="${text.substring(0, 40)}"`);
        return true;
      } catch { continue; }
    }
  }

  // Fallback: try any non-void, non-anchor link
  const anyClickable = await page.$('a[href]:not([href^="#"]):not([href^="javascript:"])');
  if (anyClickable) {
    try {
      const href = await anyClickable.getAttribute("href") || "";
      const text = (await anyClickable.textContent())?.trim()?.substring(0, 40) || "first_link";
      await anyClickable.evaluate((e: any) => { e.click(); });
      resolutionLog.push(`RESOLVE strategy=headless clicked_first_link href="${href.substring(0, 60)}"`);
      logger.log(jobId, "RESOLVE", `strategy=headless clicked_first_link href="${href.substring(0, 60)}"`);
      return true;
    } catch { /* skip */ }
  }

  return false;
}

export async function resolveHostLink(
  hostLink: HostLink,
  jobId: string
): Promise<MediaResource | null> {
  logger.log(jobId, "RESOLVE", `resolving host_link=${hostLink.landingUrl} filename=${hostLink.filename}`);

  const staticResult = await resolveStatic(hostLink.landingUrl, jobId);
  if (staticResult) return staticResult;

  const headlessResult = await resolveViaHeadless(hostLink.landingUrl, jobId);
  if (headlessResult) return headlessResult;

  logger.log(jobId, "RESOLVE", `status=resolution_failed url=${hostLink.landingUrl}`);
  return null;
}

function extractFilenameFromDisposition(contentDisposition: string): string | null {
  if (!contentDisposition) return null;
  const filenameStar = contentDisposition.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\s]+)/i);
  if (filenameStar) {
    try { return decodeURIComponent(filenameStar[1].replace(/"/g, "")); }
    catch { return filenameStar[1].replace(/"/g, ""); }
  }
  const filenameMatch = contentDisposition.match(/filename\s*=\s*"?([^";\s]+)"?/i);
  if (filenameMatch) return filenameMatch[1].replace(/"/g, "");
  return null;
}

function extractFilenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] || "unnamed";
    return decodeURIComponent(last).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  } catch {
    return "unnamed";
  }
}

function guessFileTypeFromMime(mimeType: string): FileType {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.includes("pdf")) return "document";
  if (mimeType.includes("zip") || mimeType.includes("rar") || mimeType.includes("x-7z")) return "archive";
  return "other";
}

function guessFileTypeFromUrl(url: string): FileType {
  const ext = url.split(".").pop()?.split("?")[0]?.toLowerCase() || "";
  if (["mp4", "webm", "mkv", "avi", "mov", "flv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "flac", "m4a", "aac"].includes(ext)) return "audio";
  if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["pdf", "doc", "docx", "txt"].includes(ext)) return "document";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "archive";
  return "other";
}

function guessMimeTypeFromUrl(url: string): string {
  const ext = url.split(".").pop()?.split("?")[0]?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    m4a: "audio/mp4",
    jpg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    zip: "application/zip",
  };
  return mimeMap[ext] || "application/octet-stream";
}
