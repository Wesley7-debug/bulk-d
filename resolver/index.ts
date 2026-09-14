import * as cheerio from "cheerio";
import type { BrowserContext, Page } from "playwright";
import { HostLink, MediaResource, FileType, UserIntent, HostLinkResolveResult } from "../types";
import { normalizeUrlSafe } from "../lib/utils";
import {
  HOST_FILE_SIZE_PATTERN,
  HOST_FILENAME_PATTERN,
  DOWNLOAD_CTA_PATTERNS,
  JS_VOID_HREF,
  HASH_ONLY_HREF,
  RESOLVE_MAX_HOPS,
  RESOLVE_TIMEOUT_MS,
  HEADLESS_TIMEOUT_MS,
  DOWNLOAD_EVENT_TIMEOUT_MS,
  TITLE_MATCH_THRESHOLD,
} from "../lib/constants";
import { detectHostLandingPage } from "./page-classifier";
import { logger } from "../lib/logger";

const MEDIA_EXT_REGEX = /\.(mp4|webm|mkv|avi|mov|wmv|flv|webm|mp3|wav|flac|aac|ogg|m4a|zip|rar|7z|pdf)(?:\?[^"'\s]*)?$/i;
const RESOLVER_OVERALL_TIMEOUT_MS = Math.max(HEADLESS_TIMEOUT_MS + 15_000, 45_000);
const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];
const ERROR_CONTENT_TYPES = ["application/json", "text/plain", "application/xml", "text/xml"];
const MEDIA_CONTENT_TYPES = [
  "video/",
  "audio/",
  "application/zip",
  "application/x-rar",
  "application/x-7z",
  "application/x-tar",
  "application/gzip",
  "application/vnd.rar",
  "application/x-7z-compressed",
];

interface HttpInspection {
  url: string;
  status: number;
  ok: boolean;
  contentType: string;
  contentLength?: number;
  contentDisposition: string;
  classification: "media" | "html_intermediary" | "challenge" | "login" | "error" | "unknown";
  reason?: string;
  bodyText?: string;
}

interface HeadlessResolveResult {
  resource: MediaResource | null;
  reason?: string;
}

interface CapturedResponse {
  url: string;
  contentType: string;
  contentDisposition: string;
  status: number;
  contentLength: number;
}

function parseContentLength(value: string | null | undefined): number | undefined {
  const parsed = parseInt(value || "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isHtmlContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return HTML_CONTENT_TYPES.some((ct) => lower.includes(ct));
}

function isErrorContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return ERROR_CONTENT_TYPES.some((ct) => lower.includes(ct));
}

function isVerifiedMediaResponse(contentType: string, contentDisposition: string): boolean {
  const lowerCt = contentType.toLowerCase();
  const lowerDisposition = contentDisposition.toLowerCase();
  if (/attachment/.test(lowerDisposition)) return true;
  if (lowerCt.includes("application/octet-stream")) return /attachment/.test(lowerDisposition);
  return MEDIA_CONTENT_TYPES.some((ct) => lowerCt.includes(ct));
}

function classifyHtmlBody(bodyText: string): HttpInspection["classification"] {
  const lower = bodyText.toLowerCase();
  if (/\b(captcha|recaptcha|hcaptcha|cloudflare|challenge|verify you are human|checking your browser)\b/.test(lower)) {
    return "challenge";
  }
  if (/\b(sign in|log in|login|required authentication|account required|password)\b/.test(lower)) {
    return "login";
  }
  if (/\b(not found|file removed|expired|server error|access denied|forbidden)\b/.test(lower)) {
    return "error";
  }
  return "html_intermediary";
}

async function inspectHttpResponse(
  url: string,
  jobId: string,
  requestHeaders?: Record<string, string>
): Promise<HttpInspection> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        Range: "bytes=0-0",
        ...requestHeaders,
      },
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") || "";
    const contentDisposition = response.headers.get("content-disposition") || "";
    const contentLength = parseContentLength(response.headers.get("content-length"));
    const finalUrl = response.url || url;

    if (!response.ok) {
      return {
        url: finalUrl,
        status: response.status,
        ok: false,
        contentType,
        contentLength,
        contentDisposition,
        classification: "error",
        reason: `http_${response.status}`,
      };
    }

    if (isVerifiedMediaResponse(contentType, contentDisposition)) {
      const bodyBytes = await response.arrayBuffer().then((ab) => Buffer.from(ab)).catch(() => null);

      if (bodyBytes && bodyBytes.length > 0) {
        const head = bodyBytes.slice(0, 512).toString("utf-8").toLowerCase().trim();
        if (
          head.startsWith("<!doctype") || head.startsWith("<html") ||
          head.startsWith("<head") || head.startsWith("<body") ||
          head.startsWith("<script") || head.startsWith("<!--") ||
          head.startsWith("<?xml")
        ) {
          const bodyText = bodyBytes.toString("utf-8");
          const classification = classifyHtmlBody(bodyText);
          return {
            url: finalUrl,
            status: response.status,
            ok: true,
            contentType,
            contentLength,
            contentDisposition,
            classification,
            reason: `claimed_media_but_html_body_${classification}`,
            bodyText: bodyText.substring(0, 2000),
          };
        }
      }

      await response.body?.cancel().catch(() => {});
      return {
        url: finalUrl,
        status: response.status,
        ok: true,
        contentType: contentType || "application/octet-stream",
        contentLength,
        contentDisposition,
        classification: "media",
      };
    }

    if (isHtmlContentType(contentType)) {
      const bodyText = await response.text();
      const classification = classifyHtmlBody(bodyText);
      return {
        url: finalUrl,
        status: response.status,
        ok: true,
        contentType,
        contentLength,
        contentDisposition,
        classification,
        reason: classification === "html_intermediary" ? "html_intermediary" : `${classification}_detected`,
        bodyText,
      };
    }

    if (MEDIA_EXT_REGEX.test(finalUrl) && !isErrorContentType(contentType)) {
      const bodyBytes = await response.arrayBuffer().then((ab) => Buffer.from(ab)).catch(() => null);
      if (bodyBytes && bodyBytes.length > 0) {
        const head = bodyBytes.slice(0, 512).toString("utf-8").toLowerCase().trim();
        if (
          head.startsWith("<!doctype") || head.startsWith("<html") ||
          head.startsWith("<head") || head.startsWith("<body") ||
          head.startsWith("<script") || head.startsWith("<!--") ||
          head.startsWith("<?xml")
        ) {
          const bodyText = bodyBytes.toString("utf-8");
          const classification = classifyHtmlBody(bodyText);
          return {
            url: finalUrl,
            status: response.status,
            ok: true,
            contentType,
            contentLength,
            contentDisposition,
            classification,
            reason: `media_extension_but_html_body_${classification}`,
            bodyText: bodyText.substring(0, 2000),
          };
        }
        return {
          url: finalUrl,
          status: response.status,
          ok: true,
          contentType: contentType || "application/octet-stream",
          contentLength,
          contentDisposition,
          classification: "media",
        };
      }
    }

    await response.body?.cancel().catch(() => {});
    return {
      url: finalUrl,
      status: response.status,
      ok: true,
      contentType,
      contentLength,
      contentDisposition,
      classification: isErrorContentType(contentType) ? "error" : "unknown",
      reason: isErrorContentType(contentType) ? "non_media_error_response" : "unverified_content_type",
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : "unknown";
    logger.log(jobId, "RESOLVE", `status=failed reason=${reason}`);
    return {
      url,
      status: 0,
      ok: false,
      contentType: "",
      contentDisposition: "",
      classification: "error",
      reason,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildBrowserSessionHeaders(
  context: BrowserContext,
  url: string,
  referer?: string
): Promise<Record<string, string>> {
  const cookies = await context.cookies(url).catch(() => []);
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Encoding": "identity",
  };
  if (referer) headers.Referer = referer;
  if (cookies.length > 0) {
    headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }
  return headers;
}

async function verifyBrowserSessionDownload(
  context: BrowserContext,
  url: string,
  jobId: string,
  resolutionLog: string[],
  referer?: string,
  suggestedFilename?: string
): Promise<MediaResource | null> {
  const requestHeaders = await buildBrowserSessionHeaders(context, url, referer);
  const inspection = await inspectHttpResponse(url, jobId, requestHeaders);

  resolutionLog.push(`RESOLVE final_content_type=${inspection.contentType || "unknown"}`);
  resolutionLog.push(`RESOLVE final_url=${inspection.url}`);
  logger.log(jobId, "RESOLVE", `final_content_type=${inspection.contentType || "unknown"}`);
  logger.log(jobId, "RESOLVE", `final_url=${inspection.url}`);

  if (inspection.classification !== "media") {
    const reason = inspection.reason || inspection.classification || "no_download_response";
    resolutionLog.push(`RESOLVE status=failed reason=${reason}`);
    logger.log(jobId, "RESOLVE", `status=failed reason=${reason}`);
    return null;
  }

  const filename = suggestedFilename
    || extractFilenameFromDisposition(inspection.contentDisposition)
    || extractFilenameFromUrl(inspection.url);
  resolutionLog.push("RESOLVE status=success");
  logger.log(jobId, "RESOLVE", `status=success final_url=${inspection.url}`, {
    finalContentType: inspection.contentType,
    contentLength: inspection.contentLength,
  });

  return {
    url: inspection.url,
    filename,
    fileType: guessFileTypeFromMime(inspection.contentType),
    mimeType: inspection.contentType,
    size: inspection.contentLength,
    requestHeaders,
    resolutionStrategy: "headless",
    resolutionLog,
  };
}

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
    const resolved = normalizeUrlSafe(link.href, pageUrl);
    if (!resolved) {
      logger.log(jobId, "HOST_DETECT", "url_rejected", {
        rawHref: link.href,
        baseUrl: pageUrl,
        normalizedUrl: null,
        reason: "INVALID_URL",
      });
      continue;
    }

    let linkHost: string;
    let pageHost: string;
    try {
      linkHost = new URL(resolved).hostname.toLowerCase();
      pageHost = new URL(pageUrl).hostname.toLowerCase();
    } catch {
      logger.log(jobId, "HOST_DETECT", "url_rejected", {
        rawHref: link.href,
        baseUrl: pageUrl,
        normalizedUrl: resolved,
        reason: "URL_PARSE_FAILED",
      });
      continue;
    }
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
    logger.log(jobId, "RESOLVE", `source_url=${url}`);
    const inspection = await inspectHttpResponse(url, jobId);

    resolutionLog.push(`RESOLVE initial_status=${inspection.status}`);
    resolutionLog.push(`RESOLVE initial_content_type=${inspection.contentType || "unknown"}`);
    resolutionLog.push(`RESOLVE classification=${inspection.classification}`);
    logger.log(jobId, "RESOLVE", `initial_status=${inspection.status}`);
    logger.log(jobId, "RESOLVE", `initial_content_type=${inspection.contentType || "unknown"}`);
    logger.log(jobId, "RESOLVE", `classification=${inspection.classification}`, {
      finalUrl: inspection.url,
      contentLength: inspection.contentLength,
      contentDisposition: inspection.contentDisposition,
    });

    if (!inspection.ok) {
      resolutionLog.push(`RESOLVE status=failed reason=${inspection.reason || "http_error"}`);
      logger.log(jobId, "RESOLVE", `status=failed reason=${inspection.reason || "http_error"}`);
      return null;
    }

    if (inspection.classification === "media") {
      const filename = extractFilenameFromDisposition(inspection.contentDisposition)
        || extractFilenameFromUrl(inspection.url);
      resolutionLog.push(`RESOLVE strategy=direct_typed_link final_content_type=${inspection.contentType}`);
      resolutionLog.push(`RESOLVE final_url=${inspection.url}`);
      resolutionLog.push("RESOLVE status=success");
      logger.log(jobId, "RESOLVE", `strategy=direct_typed_link status=success final_url=${inspection.url}`, {
        finalContentType: inspection.contentType,
        contentLength: inspection.contentLength,
        filename,
      });
      return {
        url: inspection.url,
        filename,
        fileType: guessFileTypeFromMime(inspection.contentType),
        mimeType: inspection.contentType,
        size: inspection.contentLength,
        resolutionStrategy: "static",
        resolutionLog,
      };
    }

    if (inspection.classification === "challenge" || inspection.classification === "login" || inspection.classification === "error") {
      const reason = inspection.reason || `${inspection.classification}_detected`;
      resolutionLog.push(`RESOLVE status=failed reason=${reason}`);
      logger.log(jobId, "RESOLVE", `status=failed reason=${reason}`);
      return null;
    }

    if (inspection.classification === "html_intermediary" && inspection.bodyText) {
      const $ = cheerio.load(inspection.bodyText);

      const metaRefresh = $('meta[http-equiv="refresh"]').attr("content");
      if (metaRefresh) {
        const urlMatch = metaRefresh.match(/url=(.+)/i);
        if (urlMatch) {
          let refreshUrl = urlMatch[1].trim();
          try { refreshUrl = new URL(refreshUrl, inspection.url).href; } catch { /* use as-is */ }
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
        try { videoUrl = new URL(ogVideo, inspection.url).href; } catch { /* use as-is */ }
        resolutionLog.push(`RESOLVE_STATIC strategy=og_video url=${videoUrl}`);
        logger.log(jobId, "RESOLVE", `strategy=og_video url=${videoUrl}`);
        const nested = await resolveStatic(videoUrl, jobId);
        if (nested) {
          nested.resolutionLog.unshift(...resolutionLog);
          return nested;
        }
      }

      const mediaLinks = $('a[href]').toArray()
        .map((el) => $(el).attr("href") || "")
        .filter((href) => MEDIA_EXT_REGEX.test(href));
      for (const link of mediaLinks) {
        let resolved: string;
        try { resolved = new URL(link, inspection.url).href; } catch { continue; }
        resolutionLog.push(`RESOLVE_STATIC strategy=media_link url=${resolved}`);
        logger.log(jobId, "RESOLVE", `strategy=media_link url=${resolved}`);
        const nested = await resolveStatic(resolved, jobId);
        if (nested) {
          nested.resolutionLog.unshift(...resolutionLog);
          return nested;
        }
      }
    }

    resolutionLog.push(`RESOLVE status=failed reason=${inspection.reason || inspection.classification}`);
    logger.log(jobId, "RESOLVE", `status=failed reason=${inspection.reason || inspection.classification}`);
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
): Promise<HeadlessResolveResult> {
  const pw = await getChromium();
  if (!pw) {
    logger.log(jobId, "RESOLVE", "strategy=headless status=skipped reason=playwright_not_available");
    return { resource: null, reason: "playwright_not_available" };
  }

  const resolutionLog: string[] = [];
  let browser = null;
  const fail = (reason: string): HeadlessResolveResult => {
    resolutionLog.push(`RESOLVE status=failed reason=${reason}`);
    logger.log(jobId, "RESOLVE", `status=failed reason=${reason}`);
    return { resource: null, reason };
  };

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

    const capturedResponses: CapturedResponse[] = [];

    page.on("response", async (response) => {
      const ct = response.headers()["content-type"] || "";
      const cl = parseInt(response.headers()["content-length"] || "0") || 0;
      const status = response.status();
      const rUrl = response.url();
      const disposition = response.headers()["content-disposition"] || "";

      capturedResponses.push({ url: rUrl, contentType: ct, contentDisposition: disposition, status, contentLength: cl });

      if (mediaUrl) return;

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

    logger.log(jobId, "RESOLVE", "strategy=headless wait_until=domcontentloaded");
    await page.goto(landingUrl, {
      waitUntil: "domcontentloaded",
      timeout: HEADLESS_TIMEOUT_MS,
    });

    await page.waitForTimeout(2000);

    const pageClassification = await page.evaluate(() => {
      const text = document.body?.textContent?.toLowerCase() || "";
      if (/\b(captcha|recaptcha|hcaptcha|cloudflare|challenge|verify you are human|checking your browser)\b/.test(text)) {
        return "challenge_detected";
      }
      if (/\b(sign in|log in|login|required authentication|account required|password)\b/.test(text)) {
        return "login_required";
      }
      if (/\b(not found|file removed|expired|server error|access denied|forbidden)\b/.test(text)) {
        return "error_page";
      }
      return "html_intermediary";
    }).catch(() => "html_intermediary");
    logger.log(jobId, "RESOLVE", `classification=${pageClassification}`);
    if (pageClassification !== "html_intermediary") {
      return fail(pageClassification);
    }

    // If media appeared on initial load, return it
    if (mediaUrl) {
      hopCount = 1;
      resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} status=ok media_url=${mediaUrl} ct=${mediaContentType}`);
      logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} status=ok media_url=${mediaUrl}`, {
        contentType: mediaContentType,
        contentLength: mediaContentLength,
      });
      const verified = await verifyBrowserSessionDownload(context, mediaUrl, jobId, resolutionLog, landingUrl);
      if (verified) return { resource: verified };
      return fail("no_download_response");
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
      return fail("no_download_cta");
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
      const mediaResource: MediaResource = {
        url: cdnUrl,
        filename: download.suggestedFilename() || extractFilenameFromUrl(cdnUrl),
        fileType: guessFileTypeFromUrl(cdnUrl),
        mimeType: guessMimeTypeFromUrl(cdnUrl),
        resolutionStrategy: "headless",
        resolutionLog,
      };
      return { resource: mediaResource };
    }

    // No download event — check if media appeared via response listener
    if (mediaUrl) {
      hopCount++;
      resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} status=ok media_url=${mediaUrl} ct=${mediaContentType}`);
      logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} status=ok media_url=${mediaUrl}`, {
        contentType: mediaContentType,
        contentLength: mediaContentLength,
      });
      const mediaResource: MediaResource = {
        url: mediaUrl,
        filename: extractFilenameFromUrl(mediaUrl),
        fileType: guessFileTypeFromMime(mediaContentType || ""),
        mimeType: mediaContentType || "video/mp4",
        size: mediaContentLength || undefined,
        resolutionStrategy: "headless",
        resolutionLog,
      };
      return { resource: mediaResource };
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
            const mediaResource: MediaResource = {
              url: cdnUrl2,
              filename: download2.suggestedFilename() || extractFilenameFromUrl(cdnUrl2),
              fileType: guessFileTypeFromUrl(cdnUrl2),
              mimeType: guessMimeTypeFromUrl(cdnUrl2),
              resolutionStrategy: "headless",
              resolutionLog,
            };
            return { resource: mediaResource };
          }
        }
      }
    }

    // ===== FALLBACK: Check captured responses for media =====
    const responseMedia = capturedResponses.find((r) =>
      isMediaResponse(r.contentType, "") && r.status >= 200 && r.status < 400
    );
    if (responseMedia) {
      hopCount++;
      resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} status=ok captured_response=${responseMedia.url.substring(0, 150)}`);
      logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} status=ok captured_response=${responseMedia.url.substring(0, 150)}`);
      const mediaResource: MediaResource = {
        url: responseMedia.url,
        filename: extractFilenameFromUrl(responseMedia.url),
        fileType: guessFileTypeFromMime(responseMedia.contentType),
        mimeType: responseMedia.contentType,
        size: responseMedia.contentLength || undefined,
        resolutionStrategy: "headless",
        resolutionLog,
      };
      return { resource: mediaResource };
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
        const mediaResource: MediaResource = {
          url: foundUrl,
          filename: extractFilenameFromUrl(foundUrl),
          fileType: guessFileTypeFromUrl(foundUrl),
          mimeType: guessMimeTypeFromUrl(foundUrl),
          resolutionStrategy: "headless",
          resolutionLog,
        };
        return { resource: mediaResource };
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
        const mediaResource: MediaResource = {
          url: videoUrl,
          filename: extractFilenameFromUrl(videoUrl),
          fileType: "video",
          mimeType: "video/mp4",
          resolutionStrategy: "headless",
          resolutionLog,
        };
        return { resource: mediaResource };
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
          const mediaResource: MediaResource = {
            url: resolved,
            filename: extractFilenameFromUrl(resolved),
            fileType: guessFileTypeFromUrl(resolved),
            mimeType: guessMimeTypeFromUrl(resolved),
            resolutionStrategy: "headless",
            resolutionLog,
          };
          return { resource: mediaResource };
        }
      }

      if (popupUrl && popupUrl !== page.url()) {
        hopCount++;
        resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} checking_popup=${popupUrl}`);
        logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} checking_popup=${popupUrl}`);

        const popupResult = await resolveStatic(popupUrl, jobId);
        if (popupResult) {
          popupResult.resolutionLog.unshift(...resolutionLog);
          return { resource: popupResult };
        }
      }
    }

    resolutionLog.push(`RESOLVE strategy=headless hop=${hopCount} status=failed reason=no_media_found`);
    logger.log(jobId, "RESOLVE", `strategy=headless hop=${hopCount} status=failed reason=no_media_found`, {
      capturedResponseCount: capturedResponses.length,
      capturedTypes: capturedResponses.slice(0, 10).map((r) => ({ url: r.url.substring(0, 80), ct: r.contentType, status: r.status })),
    });
    return fail("no_media_found");
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    resolutionLog.push(`RESOLVE strategy=headless status=error reason=${msg}`);
    logger.log(jobId, "RESOLVE", `strategy=headless status=error reason=${msg}`);
    return fail(msg);
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
  page: Page,
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
    const disabled = await el.evaluate((e: Element) => "disabled" in e && Boolean((e as HTMLButtonElement).disabled)).catch(() => false);

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
        await page.evaluate((url: string) => { (window as Window & { __mediaHref?: string }).__mediaHref = url; }, resolved);
        return true;
      }

      // Use evaluate to trigger JS onclick handlers (critical for loadedfiles pattern)
      try {
        await el.evaluate((e: Element) => { (e as HTMLElement).click(); });
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
      await anyClickable.evaluate((e: Element) => { (e as HTMLElement).click(); });
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
): Promise<HostLinkResolveResult> {
  logger.log(jobId, "RESOLVE", `resolving host_link=${hostLink.landingUrl} filename=${hostLink.filename}`);

  const staticResult = await resolveStatic(hostLink.landingUrl, jobId);
  if (staticResult) {
    return {
      success: true,
      finalUrl: staticResult.url,
      contentType: staticResult.mimeType,
      contentLength: staticResult.size,
      filename: staticResult.filename,
      fileType: staticResult.fileType,
      resolutionStrategy: staticResult.resolutionStrategy,
      resolutionLog: staticResult.resolutionLog,
    };
  }

  const headlessResult = await resolveViaHeadless(hostLink.landingUrl, jobId);
  if (headlessResult.resource) {
    const r = headlessResult.resource;
    logger.log(jobId, "RESOLVE", `strategy=headless final_url=${r.url} ct=${r.mimeType} filename=${r.filename}`);
    return {
      success: true,
      finalUrl: r.url,
      contentType: r.mimeType,
      contentLength: r.size,
      filename: r.filename,
      fileType: r.fileType,
      resolutionStrategy: r.resolutionStrategy,
      resolutionLog: r.resolutionLog,
    };
  }

  const reason = headlessResult.reason || "no_media_found";
  logger.log(jobId, "RESOLVE", `status=resolution_failed reason=${reason} url=${hostLink.landingUrl}`);
  return {
    success: false,
    reason,
    resolutionLog: headlessResult.resource === null ? [] : undefined,
  };
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
