import * as cheerio from "cheerio";
import { normalizeUrl, areSameDomain, getBaseDomain } from "../lib/utils";
import { SERIES_PATTERNS } from "../lib/constants";
import { SiteDiscoveryResult } from "../types";

class SiteDiscoveryEngine {
  async discoverFromPage(
    $: cheerio.CheerioAPI,
    pageUrl: string
  ): Promise<SiteDiscoveryResult> {
    const relatedUrls: string[] = [];
    const paginationUrls: string[] = [];
    const seriesUrls: string[] = [];
    const metadata: Record<string, string> = {};

    const title = $("title").text().trim() ||
      $('meta[property="og:title"]').attr("content") ||
      $("h1").first().text().trim() ||
      undefined;

    const description =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      undefined;

    const ogImage = $('meta[property="og:image"]').attr("content");
    if (ogImage) metadata.thumbnail = ogImage;

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      let normalized: string;
      try {
        normalized = normalizeUrl(href, pageUrl);
      } catch {
        return;
      }

      if (!areSameDomain(normalized, pageUrl)) return;

      const linkText = $(el).text().toLowerCase().trim();
      const pathname = new URL(normalized).pathname.toLowerCase();

      if (this.isPaginationLink(linkText, pathname)) {
        paginationUrls.push(normalized);
      } else if (this.isSeriesLink(linkText, pathname)) {
        seriesUrls.push(normalized);
      } else {
        relatedUrls.push(normalized);
      }
    });

    return {
      relatedUrls: [...new Set(relatedUrls)],
      paginationUrls: [...new Set(paginationUrls)],
      seriesUrls: [...new Set(seriesUrls)],
      title,
      description,
      metadata,
    };
  }

  private isPaginationLink(text: string, pathname: string): boolean {
    const paginationPatterns = [
      /page[\/_-]?\d+/i,
      /p[\/_-]?\d+/i,
      /\?page=\d+/i,
      /offset[\/_-]?\d+/i,
      /start[\/_-]?\d+/i,
    ];
    if (paginationPatterns.some((p) => p.test(pathname))) return true;
    const paginationTexts = ["next", "prev", "previous", "last", "more"];
    if (paginationTexts.some((t) => text.includes(t))) return true;
    const numberedText = text.match(/^\d+$/);
    if (numberedText && parseInt(numberedText[0]) > 1) return true;
    return false;
  }

  private isSeriesLink(text: string, pathname: string): boolean {
    if (SERIES_PATTERNS.some((p) => p.test(pathname))) return true;
    if (SERIES_PATTERNS.some((p) => p.test(text))) return true;
    const seriesKeywords = ["series", "episodes", "season", "collection", "watch"];
    if (seriesKeywords.some((k) => pathname.includes(k))) return true;
    return false;
  }

  shouldFollowUrl(url: string, entryUrl: string): boolean {
    try {
      const parsed = new URL(url);
      const entryParsed = new URL(entryUrl);
      const hostParts = parsed.hostname.split(".");
      const entryParts = entryParsed.hostname.split(".");
      const urlDomain = hostParts.slice(-2).join(".");
      const entryDomain = entryParts.slice(-2).join(".");
      if (urlDomain !== entryDomain) return false;
      const ext = parsed.pathname.split(".").pop()?.toLowerCase() || "";
      const nonPageExts = [
        "mp4", "webm", "mkv", "avi", "mov", "flv",
        "mp3", "wav", "ogg", "flac", "m4a", "aac",
        "jpg", "jpeg", "png", "gif", "webp", "svg",
        "pdf", "zip", "rar", "7z", "tar", "gz",
        "js", "css", "json", "xml",
        "ico", "woff", "woff2", "ttf", "eot",
      ];
      if (nonPageExts.includes(ext)) return false;
      return true;
    } catch {
      return false;
    }
  }
}

export const siteDiscovery = new SiteDiscoveryEngine();
