import * as cheerio from "cheerio";
import { PageClassification, PageClassificationResult } from "../types";
import {
  HOST_FILE_SIZE_PATTERN,
  HOST_FILENAME_PATTERN,
  DOWNLOAD_CTA_PATTERNS,
  JS_VOID_HREF,
  HASH_ONLY_HREF,
} from "../lib/constants";

const EPISODE_NUMBERING = [
  /\bep(?:isode)?[\s._-]*\d+/i,
  /\bs\d+e\d+/i,
  /\bpart[\s._-]*\d+/i,
  /\bvol(?:ume)?[\s._-]*\d+/i,
  /\bchapter[\s._-]*\d+/i,
];

const MEDIA_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|mp3|wav|flac|aac|zip|rar|7z|pdf)(?:\?[^"'\s]*)?$/i;

const LOCKER_KEYWORDS = [
  "locker", "share", "drive", "upload", "cdn", "download",
  "files", "file", "stored", "storage", "vault", "box",
];

export function classifyPage(
  url: string,
  html: string
): PageClassificationResult {
  const $ = cheerio.load(html);
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();
  const pathname = parsedUrl.pathname.toLowerCase();

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  const allLinks: Array<{ href: string; text: string }> = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim();
    allLinks.push({ href, text });
  });

  const episodeLinks = allLinks.filter((l) =>
    EPISODE_NUMBERING.some((p) => p.test(l.text) || p.test(l.href))
  );

  const mediaLinks = allLinks.filter((l) => MEDIA_EXTENSIONS.test(l.href));

  const directDownloadLinks = allLinks.filter((l) => {
    try {
      const u = new URL(l.href, url);
      const ext = u.pathname.split(".").pop()?.toLowerCase() || "";
      return ["exe", "msi", "dmg", "deb", "rpm", "appimage", "zip", "tar", "gz", "rar", "7z", "pdf", "iso", "img", "bin", "apk"].includes(ext)
        || MEDIA_EXTENSIONS.test(l.href);
    } catch {
      return false;
    }
  });

  const linkPatterns = new Map<string, number>();
  for (const l of allLinks) {
    try {
      const u = new URL(l.href, url);
      const pattern = u.pathname.replace(/\d+/g, "N").replace(/\/+/g, "/");
      linkPatterns.set(pattern, (linkPatterns.get(pattern) || 0) + 1);
    } catch { /* skip */ }
  }
  const repeatedPatterns = [...linkPatterns.values()].filter((c) => c >= 3).length;

  const hasPagination =
    $('nav[class*="pagination"], .pagination, .page-numbers, [class*="pager"], a[rel="next"]').length > 0
    || $('[class*="pagination"]').length > 0;

  const hasArticle = $("article, .post, .entry-content, .article-content").length > 0
    || $('[itemtype*="Article"]').length > 0;

  const hasListing = $(".archive, .tag, .category, .search-results").length > 0
    || $('[class*="archive"], [class*="listing"], [class*="grid"]').length > 0;

  const cardSelectors = [".card", ".post-card", ".entry-card", ".item", '[class*="card"]', '[class*="thumb"]'];
  let cardCount = 0;
  for (const sel of cardSelectors) {
    cardCount += $(sel).length;
  }

  const ctaButtons = allLinks.filter((l) => {
    const text = l.text.toLowerCase().trim();
    const href = l.href.toLowerCase();
    return (
      DOWNLOAD_CTA_PATTERNS.some((p) => p.test(text)) ||
      JS_VOID_HREF.test(href) ||
      HASH_ONLY_HREF.test(href) ||
      (text.includes("download") && text.length < 30)
    );
  });

  const hasFileSize = HOST_FILE_SIZE_PATTERN.test(bodyText);
  const hasFilenameInText = MEDIA_EXTENSIONS.test(bodyText);

  const jsHrefs = allLinks.filter((l) =>
    JS_VOID_HREF.test(l.href) || HASH_ONLY_HREF.test(l.href) || l.href.includes("void")
  );

  const downloadForms = $("form").filter((_, el) => {
    const action = $(el).attr("action") || "";
    const id = $(el).attr("id") || "";
    const cls = $(el).attr("class") || "";
    return /download|submit|gate|unlock|protect/i.test(action + id + cls);
  });

  const scores: Record<PageClassification, number> = {
    CONTENT_INDEX: 0,
    CONTENT_PAGE: 0,
    HOST_LANDING_PAGE: 0,
    DIRECT_RESOURCE: 0,
  };
  const reasons: Record<PageClassification, string[]> = {
    CONTENT_INDEX: [],
    CONTENT_PAGE: [],
    HOST_LANDING_PAGE: [],
    DIRECT_RESOURCE: [],
  };

  if (MEDIA_EXTENSIONS.test(pathname) && !bodyText.includes("<html")) {
    scores.DIRECT_RESOURCE = 0.95;
    reasons.DIRECT_RESOURCE.push("URL path ends with media extension");
  }

  if (hasListing) {
    scores.CONTENT_INDEX += 0.3;
    reasons.CONTENT_INDEX.push("archive/tag/category listing markup");
  }
  if (repeatedPatterns >= 2) {
    scores.CONTENT_INDEX += 0.25;
    reasons.CONTENT_INDEX.push(`${repeatedPatterns} repeated link patterns (listing)`);
  }
  if (hasPagination) {
    scores.CONTENT_INDEX += 0.15;
    reasons.CONTENT_INDEX.push("pagination controls present");
  }
  if (cardCount >= 3) {
    scores.CONTENT_INDEX += 0.2;
    reasons.CONTENT_INDEX.push(`${cardCount} card elements (listing grid)`);
  }
  if (episodeLinks.length === 0 && allLinks.length > 10) {
    scores.CONTENT_INDEX += 0.1;
    reasons.CONTENT_INDEX.push("many links but no episode-numbered links");
  }
  if (/\/(tag|category|search|archive)\//i.test(pathname)) {
    scores.CONTENT_INDEX += 0.2;
    reasons.CONTENT_INDEX.push("URL path contains tag/category/search segment");
  }

  if (episodeLinks.length >= 3) {
    scores.CONTENT_PAGE += 0.35;
    reasons.CONTENT_PAGE.push(`${episodeLinks.length} episode-numbered links`);
  }
  if (mediaLinks.length >= 3) {
    scores.CONTENT_PAGE += 0.25;
    reasons.CONTENT_PAGE.push(`${mediaLinks.length} media-extension links`);
  }
  if (directDownloadLinks.length >= 2) {
    scores.CONTENT_PAGE += 0.3;
    reasons.CONTENT_PAGE.push(`${directDownloadLinks.length} direct download links`);
  }
  if (hasArticle) {
    scores.CONTENT_PAGE += 0.15;
    reasons.CONTENT_PAGE.push("article/post content structure");
  }
  if (episodeLinks.length >= 3 && mediaLinks.length >= 3) {
    scores.CONTENT_PAGE += 0.2;
    reasons.CONTENT_PAGE.push("both episode numbering AND media extensions present");
  }

  if (ctaButtons.length >= 1 && !hasArticle) {
    scores.HOST_LANDING_PAGE += 0.2;
    reasons.HOST_LANDING_PAGE.push(`${ctaButtons.length} download CTA button(s)`);
  }
  if (jsHrefs.length >= 1 && !hasArticle) {
    scores.HOST_LANDING_PAGE += 0.15;
    reasons.HOST_LANDING_PAGE.push(`${jsHrefs.length} JS-only/void href(s)`);
  }
  if (hasFileSize) {
    scores.HOST_LANDING_PAGE += 0.15;
    reasons.HOST_LANDING_PAGE.push("file size text present");
  }
  if (hasFilenameInText && hasFileSize) {
    scores.HOST_LANDING_PAGE += 0.15;
    reasons.HOST_LANDING_PAGE.push("filename + file size in page text");
  }
  if (allLinks.length <= 10 && !hasArticle) {
    scores.HOST_LANDING_PAGE += 0.1;
    reasons.HOST_LANDING_PAGE.push(`few links (${allLinks.length}), no article structure`);
  }
  if (downloadForms.length > 0) {
    scores.HOST_LANDING_PAGE += 0.15;
    reasons.HOST_LANDING_PAGE.push("download-gate form present");
  }
  const lockerHint = LOCKER_KEYWORDS.some((k) => hostname.includes(k));
  if (lockerHint) {
    scores.HOST_LANDING_PAGE += 0.1;
    reasons.HOST_LANDING_PAGE.push("hostname contains locker/share keyword");
  }
  if (ctaButtons.length === 1 && allLinks.length <= 8) {
    scores.HOST_LANDING_PAGE += 0.1;
    reasons.HOST_LANDING_PAGE.push("single prominent CTA, few total links");
  }

  const total = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
  for (const key of Object.keys(scores) as PageClassification[]) {
    scores[key] = Math.round((scores[key] / total) * 100) / 100;
  }

  const entries = (Object.entries(scores) as Array<[PageClassification, number]>)
    .sort((a, b) => b[1] - a[1]);
  const [classification, confidence] = entries[0];

  return {
    classification,
    confidence,
    reasons: reasons[classification],
    scores,
  };
}

export function detectHostLandingPage(
  url: string,
  html: string
): { isHostLandingPage: boolean; confidence: number; signals: string[] } {
  const $ = cheerio.load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const signals: string[] = [];
  let confidence = 0;

  const filenameMatch = bodyText.match(HOST_FILENAME_PATTERN);
  if (filenameMatch) {
    signals.push(`filename-like string found: "${filenameMatch[0]}"`);
    confidence += 0.25;
  }

  const sizeMatch = bodyText.match(HOST_FILE_SIZE_PATTERN);
  if (sizeMatch) {
    signals.push(`file size string found: "${sizeMatch[0]}"`);
    confidence += 0.2;
  }

  if (filenameMatch && sizeMatch) {
    const fnameIdx = bodyText.indexOf(filenameMatch[0]);
    const sizeIdx = bodyText.indexOf(sizeMatch[0]);
    if (Math.abs(fnameIdx - sizeIdx) < 200) {
      signals.push("filename and file size appear near each other");
      confidence += 0.15;
    }
  }

  const allLinks: Array<{ href: string; text: string }> = [];
  $("a[href]").each((_, el) => {
    allLinks.push({
      href: $(el).attr("href") || "",
      text: $(el).text().trim(),
    });
  });

  const downloadLinks = allLinks.filter((l) => {
    const text = l.text.toLowerCase().trim();
    return DOWNLOAD_CTA_PATTERNS.some((p) => p.test(text));
  });

  if (downloadLinks.length === 1) {
    signals.push(`single download CTA: "${downloadLinks[0].text}"`);
    confidence += 0.15;
  } else if (downloadLinks.length > 1) {
    signals.push(`${downloadLinks.length} download-like CTAs`);
    confidence += 0.1;
  }

  const vagueLinks = downloadLinks.filter((l) =>
    JS_VOID_HREF.test(l.href) ||
    HASH_ONLY_HREF.test(l.href) ||
    l.href.includes("void") ||
    !l.href.startsWith("http")
  );
  if (vagueLinks.length > 0) {
    signals.push(`${vagueLinks.length} CTA(s) with JS/vague href`);
    confidence += 0.15;
  }

  const hasCountdown =
    bodyText.includes("countdown") ||
    bodyText.includes("seconds") ||
    bodyText.includes("please wait") ||
    bodyText.includes("loading") ||
    bodyText.includes("generating") ||
    $('[class*="countdown"], [id*="countdown"], [class*="timer"]').length > 0;
  if (hasCountdown) {
    signals.push("countdown/wait/processing indicator present");
    confidence += 0.1;
  }

  const hasDownloadForm = $("form").filter((_, el) =>
    /download|submit|gate|unlock/i.test(
      ($(el).attr("action") || "") + ($(el).attr("id") || "") + ($(el).attr("class") || "")
    )
  ).length > 0;
  if (hasDownloadForm) {
    signals.push("download-gate form present");
    confidence += 0.15;
  }

  const hostname = new URL(url).hostname.toLowerCase();
  const lockerHint = LOCKER_KEYWORDS.some((k) => hostname.includes(k));
  if (lockerHint) {
    signals.push("hostname contains locker/share keyword (weak signal)");
    confidence += 0.05;
  }

  return {
    isHostLandingPage: confidence >= 0.4,
    confidence: Math.round(Math.min(confidence, 1) * 100) / 100,
    signals,
  };
}
