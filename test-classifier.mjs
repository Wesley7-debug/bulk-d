#!/usr/bin/env node
/**
 * Standalone test: Page Classifier + Host-Landing-Page Detector
 * Run with: node test-classifier.mjs
 */

import * as cheerio from "cheerio";
import { readFileSync } from "fs";

// ─── SIGNALS & PATTERNS (generic, not site-specific) ───

const EPISODE_NUMBERING = [
  /\bep(?:isode)?[\s._-]*\d+/i,
  /\bs\d+e\d+/i,
  /\bpart[\s._-]*\d+/i,
  /\bvol(?:ume)?[\s._-]*\d+/i,
  /\bchapter[\s._-]*\d+/i,
];

const QUALITY_LABELS = /\b(1080p?|720p?|480p?|360p?|hd|sd|uhd|4k)\b/i;

const FILE_SIZE_PATTERN = /\b\d+(?:\.\d+)?\s*(?:b|kb|mb|gb|tb)\b/i;

const MEDIA_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|mp3|wav|flac|aac|zip|rar|7z|pdf)(?:\?[^"'\s]*)?$/i;

const DOWNLOAD_CTA_TEXT = /^(?:download|free download|download now|click here to download|get link|download link|start download|direct download)$/i;

const JS_VOID_HREF = /^javascript\s*:/i;
const HASH_ONLY_HREF = /^#(?:\w*)$/;

const LOCKER_KEYWORDS = [
  "locker", "share", "drive", "upload", "cdn", "download",
  "files", "file", "stored", "storage", "vault", "box",
];

// ─── PAGE CLASSIFIER ───

function classifyPage(url, html) {
  const $ = cheerio.load(html);
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();
  const pathname = parsedUrl.pathname.toLowerCase();

  // ── Signal extraction ──
  const title = $("title").text().trim() ||
    $('meta[property="og:title"]').attr("content") || "";
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const bodyTextLower = bodyText.toLowerCase();

  // Count links
  const allLinks = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim();
    allLinks.push({ href, text });
  });

  // Count episode-numbered links
  const episodeLinks = allLinks.filter((l) =>
    EPISODE_NUMBERING.some((p) => p.test(l.text) || p.test(l.href))
  );

  // Count media-extension links
  const mediaLinks = allLinks.filter((l) => MEDIA_EXTENSIONS.test(l.href));

  // Count direct download links (binary/media files, not HTML pages)
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

  // Count near-identical link patterns (listing signals)
  const linkPatterns = new Map();
  for (const l of allLinks) {
    try {
      const u = new URL(l.href, url);
      const pattern = u.pathname.replace(/\d+/g, "N").replace(/\/+/g, "/");
      linkPatterns.set(pattern, (linkPatterns.get(pattern) || 0) + 1);
    } catch {}
  }
  const repeatedPatterns = [...linkPatterns.values()].filter((c) => c >= 3).length;

  // Check for pagination
  const hasPagination = $('nav[class*="pagination"], .pagination, .page-numbers, [class*="pager"], a[rel="next"]').length > 0
    || $('[class*="pagination"]').length > 0;

  // Check for article/post structure
  const hasArticle = $("article, .post, .entry-content, .article-content").length > 0
    || $('[itemtype*="Article"]').length > 0;

  // Check for listing/archive structure
  const hasListing = $(".archive, .tag, .category, .search-results").length > 0
    || $('[class*="archive"], [class*="listing"], [class*="grid"]').length > 0;

  // Check for card-like repeated elements
  const cardSelectors = [".card", ".post-card", ".entry-card", ".item", '[class*="card"]', '[class*="thumb"]'];
  let cardCount = 0;
  for (const sel of cardSelectors) {
    cardCount += $(sel).length;
  }

  // Count CTA buttons
  const ctaButtons = allLinks.filter((l) => {
    const text = l.text.toLowerCase().trim();
    const href = l.href.toLowerCase();
    return (
      DOWNLOAD_CTA_TEXT.test(text) ||
      JS_VOID_HREF.test(href) ||
      HASH_ONLY_HREF.test(href) ||
      (text.includes("download") && text.length < 30)
    );
  });

  // Check for file size text near download links
  const hasFileSize = FILE_SIZE_PATTERN.test(bodyText);

  // Check for filename in page text
  const hasFilenameInText = MEDIA_EXTENSIONS.test(bodyText);

  // Check for JS-only href patterns
  const jsHrefs = allLinks.filter((l) =>
    JS_VOID_HREF.test(l.href) || HASH_ONLY_HREF.test(l.href) || l.href.includes("void")
  );

  // Check for forms that might be download gates
  const forms = $("form");
  const downloadForms = forms.filter((_, el) => {
    const action = $(el).attr("action") || "";
    const id = $(el).attr("id") || "";
    const cls = $(el).attr("class") || "";
    return /download|submit|gate|unlock|protect/i.test(action + id + cls);
  });

  // ── Score each page type ──
  const scores = {
    CONTENT_INDEX: 0,
    CONTENT_PAGE: 0,
    HOST_LANDING_PAGE: 0,
    DIRECT_RESOURCE: 0,
    UNKNOWN: 0,
  };
  const reasons = {
    CONTENT_INDEX: [],
    CONTENT_PAGE: [],
    HOST_LANDING_PAGE: [],
    DIRECT_RESOURCE: [],
    UNKNOWN: [],
  };

  // Check for DIRECT_RESOURCE (response is media bytes)
  const contentType = ""; // We don't have headers here, check via extension
  if (MEDIA_EXTENSIONS.test(pathname) && !bodyText.includes("<html")) {
    scores.DIRECT_RESOURCE = 0.95;
    reasons.DIRECT_RESOURCE.push("URL path ends with media extension");
  }

  // CONTENT_INDEX signals
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
  if (/\/tag\//i.test(pathname) || /\/category\//i.test(pathname) || /\/search\//i.test(pathname)) {
    scores.CONTENT_INDEX += 0.2;
    reasons.CONTENT_INDEX.push("URL path contains tag/category/search segment");
  }

  // CONTENT_PAGE signals
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
    reasons.CONTENT_PAGE.push(`${directDownloadLinks.length} direct download links (binary/media files)`);
  }
  if (hasArticle) {
    scores.CONTENT_PAGE += 0.15;
    reasons.CONTENT_PAGE.push("article/post content structure");
  }
  if (episodeLinks.length >= 3 && mediaLinks.length >= 3) {
    scores.CONTENT_PAGE += 0.2;
    reasons.CONTENT_PAGE.push("both episode numbering AND media extensions present");
  }

  // HOST_LANDING_PAGE signals
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
  // Weak TLD/keyword signal
  const lockerHint = LOCKER_KEYWORDS.some((k) => hostname.includes(k));
  if (lockerHint) {
    scores.HOST_LANDING_PAGE += 0.1;
    reasons.HOST_LANDING_PAGE.push("hostname contains locker/share keyword");
  }
  // Single prominent CTA with vague href
  if (ctaButtons.length === 1 && allLinks.length <= 8) {
    scores.HOST_LANDING_PAGE += 0.1;
    reasons.HOST_LANDING_PAGE.push("single prominent CTA, few total links");
  }

  // UNKNOWN fallback
  const maxType = Object.entries(scores).reduce((a, b) => (b[1] > a[1] ? b : a));
  if (maxType[1] < 0.3) {
    scores.UNKNOWN = 1 - maxType[1];
    reasons.UNKNOWN.push("no strong signals for any category");
  }

  // Normalize scores
  const total = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
  for (const key of Object.keys(scores)) {
    scores[key] = Math.round((scores[key] / total) * 100) / 100;
  }

  const classification = maxType[0];
  const confidence = Math.round(scores[classification] * 100) / 100;

  return {
    url,
    hostname,
    classification,
    confidence,
    scores,
    reasons: reasons[classification],
    signals: {
      title: title.substring(0, 100),
      totalLinks: allLinks.length,
      episodeLinks: episodeLinks.length,
      mediaLinks: mediaLinks.length,
      directDownloadLinks: directDownloadLinks.length,
      repeatedPatterns,
      hasPagination,
      hasArticle,
      hasListing,
      cardCount,
      ctaButtons: ctaButtons.length,
      hasFileSize,
      hasFilenameInText,
      jsHrefs: jsHrefs.length,
      downloadForms: downloadForms.length,
    },
  };
}

// ─── HOST-LANDING-PAGE DETECTOR (detailed sub-analysis) ───

function detectHostLandingPage(url, html) {
  const $ = cheerio.load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const title = $("title").text().trim() || "";

  const signals = [];
  let confidence = 0;

  // Filename-like string in page text
  const filenameMatch = bodyText.match(
    /[\w.-]+\.(mkv|mp4|avi|mov|wmv|flv|webm|zip|rar)/i
  );
  if (filenameMatch) {
    signals.push(`filename-like string found: "${filenameMatch[0]}"`);
    confidence += 0.25;
  }

  // File size string
  const sizeMatch = bodyText.match(
    /\b\d+(?:\.\d+)?\s*(?:b|kb|mb|gb|tb)\b/i
  );
  if (sizeMatch) {
    signals.push(`file size string found: "${sizeMatch[0]}"`);
    confidence += 0.2;
  }

  // Filename + size in proximity (within 200 chars)
  if (filenameMatch && sizeMatch) {
    const fnameIdx = bodyText.indexOf(filenameMatch[0]);
    const sizeIdx = bodyText.indexOf(sizeMatch[0]);
    if (Math.abs(fnameIdx - sizeIdx) < 200) {
      signals.push("filename and file size appear near each other");
      confidence += 0.15;
    }
  }

  // Single prominent CTA
  const allLinks = [];
  $("a[href]").each((_, el) => {
    allLinks.push({
      href: $(el).attr("href") || "",
      text: $(el).text().trim(),
      classes: $(el).attr("class") || "",
    });
  });

  const downloadLinks = allLinks.filter((l) => {
    const text = l.text.toLowerCase().trim();
    return (
      DOWNLOAD_CTA_TEXT.test(text) ||
      /download|get.*link|free|unlock|grab/i.test(text)
    );
  });

  if (downloadLinks.length === 1) {
    signals.push(`single download CTA: "${downloadLinks[0].text}"`);
    confidence += 0.15;
  } else if (downloadLinks.length > 1) {
    signals.push(`${downloadLinks.length} download-like CTAs`);
    confidence += 0.1;
  }

  // JS-only or vague href
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

  // Countdown/timer elements
  const hasCountdown = bodyText.includes("countdown") ||
    bodyText.includes("seconds") ||
    bodyText.includes("please wait") ||
    bodyText.includes("loading") ||
    bodyText.includes("generating") ||
    $('[class*="countdown"], [id*="countdown"], [class*="timer"]').length > 0
    || $('[class*="Countdown"], [id*="Countdown"], [class*="Timer"]').length > 0;
  if (hasCountdown) {
    signals.push("countdown/wait/processing indicator present");
    confidence += 0.1;
  }

  // Download form
  const hasDownloadForm = $("form").filter((_, el) =>
    /download|submit|gate|unlock/i.test(
      ($(el).attr("action") || "") + ($(el).attr("id") || "") + ($(el).attr("class") || "")
    )
  ).length > 0;
  if (hasDownloadForm) {
    signals.push("download-gate form present");
    confidence += 0.15;
  }

  // Weak domain keyword boost
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
    suggestedStrategy: confidence >= 0.4 ? "generic_headless_or_manual" : "none",
  };
}

// ─── TEST FIXTURES ───

const fixtures = [
  {
    name: "Nkiri Tag/Archive page (should be CONTENT_INDEX)",
    url: "https://thenkiri.ng/tag/daemons-of-the-shadow-realm-season-1/",
    expected: "CONTENT_INDEX",
    localFile: "test-fixtures/nkiri-tag.html",
  },
  {
    name: "Nkiri Content page (should be CONTENT_PAGE)",
    url: "https://thenkiri.ng/daemons-of-the-shadow-realm-s01-tv-series/",
    expected: "CONTENT_PAGE",
    localFile: "test-fixtures/nkiri-content.html",
  },
  {
    name: "Wideshares host landing page (should be HOST_LANDING_PAGE)",
    url: "https://wideshares.org/download/cf0ec0a286cc",
    expected: "HOST_LANDING_PAGE",
  },
  {
    name: "Downloadwella host landing page (should be HOST_LANDING_PAGE)",
    url: "https://downloadwella.com/r5zqf78kicgb/Daemons.of.The.Shadow.Realm.S01E06.(THENKIRI.COM).mkv.html",
    expected: "HOST_LANDING_PAGE",
  },
  {
    name: "GitHub Releases page (should be CONTENT_INDEX)",
    url: "https://github.com/yt-dlp/yt-dlp/releases",
    expected: "CONTENT_INDEX",
    localFile: "test-fixtures/github-releases.html",
  },
  {
    name: "FossHub 7-Zip page (should be CONTENT_PAGE)",
    url: "https://www.fosshub.com/7-Zip.html",
    expected: "CONTENT_PAGE",
    localFile: "test-fixtures/fosshub-7zip.html",
  },
];

// ─── RUN ───

async function fetchPage(url, localFile) {
  if (localFile) {
    try {
      const html = readFileSync(localFile, "utf-8");
      return { html, status: 200, source: "local" };
    } catch (e) {
      return { error: `Local read error: ${e.message}`, html: "" };
    }
  }
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}`, html: "" };
    const html = await resp.text();
    return { html, status: resp.status, source: "remote" };
  } catch (e) {
    return { error: e.message, html: "" };
  }
}

async function runTests() {
  console.log("=" .repeat(80));
  console.log("PAGE CLASSIFIER + HOST-LANDING-PAGE DETECTOR — TEST RUN");
  console.log("=" .repeat(80));

  for (const fixture of fixtures) {
    console.log(`\n${"─".repeat(80)}`);
    console.log(`FIXTURE: ${fixture.name}`);
    console.log(`URL: ${fixture.url}`);
    console.log(`EXPECTED: ${fixture.expected}`);
    console.log(`${"─".repeat(80)}`);

    const { html, error, source } = await fetchPage(fixture.url, fixture.localFile);
    if (error) {
      console.log(`  FETCH ERROR: ${error}`);
      continue;
    }

    console.log(`  HTML length: ${html.length} chars (source: ${source || "remote"})`);

    const classification = classifyPage(fixture.url, html);
    console.log(`\n  CLASSIFICATION:`);
    console.log(`    type:       ${classification.classification}`);
    console.log(`    confidence: ${classification.confidence}`);
    console.log(`    reasons:    ${classification.reasons.join("; ")}`);
    console.log(`    scores:     ${JSON.stringify(classification.scores)}`);
    console.log(`  SIGNALS:`);
    console.log(`    title:          "${classification.signals.title}"`);
    console.log(`    totalLinks:     ${classification.signals.totalLinks}`);
    console.log(`    episodeLinks:   ${classification.signals.episodeLinks}`);
    console.log(`    mediaLinks:     ${classification.signals.mediaLinks}`);
    console.log(`    directDownloads: ${classification.signals.directDownloadLinks}`);
    console.log(`    repeatedPatterns: ${classification.signals.repeatedPatterns}`);
    console.log(`    hasPagination:  ${classification.signals.hasPagination}`);
    console.log(`    hasArticle:     ${classification.signals.hasArticle}`);
    console.log(`    hasListing:     ${classification.signals.hasListing}`);
    console.log(`    cardCount:      ${classification.signals.cardCount}`);
    console.log(`    ctaButtons:     ${classification.signals.ctaButtons}`);
    console.log(`    hasFileSize:    ${classification.signals.hasFileSize}`);
    console.log(`    hasFilename:    ${classification.signals.hasFilenameInText}`);
    console.log(`    jsHrefs:        ${classification.signals.jsHrefs}`);

    if (classification.classification === "HOST_LANDING_PAGE") {
      const hlp = detectHostLandingPage(fixture.url, html);
      console.log(`\n  HOST-LANDING-PAGE DETAIL:`);
      console.log(`    isHostLandingPage: ${hlp.isHostLandingPage}`);
      console.log(`    confidence:        ${hlp.confidence}`);
      console.log(`    signals:           ${hlp.signals.join("; ")}`);
    }

    const match = classification.classification === fixture.expected;
    console.log(`\n  RESULT: ${match ? "PASS ✓" : "FAIL ✗"} (got ${classification.classification}, expected ${fixture.expected})`);
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log("DONE");
}

runTests().catch(console.error);
