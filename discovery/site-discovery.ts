import * as cheerio from "cheerio";
import { normalizeUrl, areSameDomain, classifyPageType } from "../lib/utils";
import { SERIES_PATTERNS } from "../lib/constants";
import { SiteDiscoveryResult, CrawlPageType } from "../types";

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

    const canonicalLink = $('link[rel="canonical"]').attr("href");
    if (canonicalLink) metadata.canonical = canonicalLink;

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

  classifyPageType(
    $: cheerio.CheerioAPI,
    url: string,
    html: string
  ): CrawlPageType {
    const linkCount = $("a[href]").length;
    const mediaCount = $("video, audio, source, embed, iframe").length;
    return classifyPageType(url, html, linkCount, mediaCount);
  }

  discoverSitemapUrls($: cheerio.CheerioAPI, pageUrl: string): string[] {
    const sitemapUrls: string[] = [];

    $('link[rel="sitemap"]').each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        try {
          sitemapUrls.push(normalizeUrl(href, pageUrl));
        } catch { /* skip */ }
      }
    });

    $('link[type="application/xml"]').each((_, el) => {
      const href = $(el).attr("href");
      if (href && (href.includes("sitemap") || href.endsWith(".xml"))) {
        try {
          sitemapUrls.push(normalizeUrl(href, pageUrl));
        } catch { /* skip */ }
      }
    });

    return [...new Set(sitemapUrls)];
  }

  discoverPaginationLinks($: cheerio.CheerioAPI, pageUrl: string): string[] {
    const paginationUrls: string[] = [];

    $('a[href]').each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      try {
        const normalized = normalizeUrl(href, pageUrl);
        const pathname = new URL(normalized).pathname.toLowerCase();
        const search = new URL(normalized).search.toLowerCase();

        if (/[?&]page=\d+/.test(search) || /\/page\/\d+/.test(pathname)) {
          paginationUrls.push(normalized);
        }
        if (/[?&]offset=\d+/.test(search) || /[?&]start=\d+/.test(search)) {
          paginationUrls.push(normalized);
        }
      } catch { /* skip */ }
    });

    return [...new Set(paginationUrls)];
  }

  async tryFetchSitemap(pageUrl: string): Promise<string[]> {
    const urls: string[] = [];
    const parsed = new URL(pageUrl);
    const origin = parsed.origin;

    for (const path of ["/sitemap.xml", "/sitemap_index.xml"]) {
      try {
        const response = await fetch(`${origin}${path}`, {
          headers: { "User-Agent": "BulkForgeBot/1.0" },
          signal: AbortSignal.timeout(5000),
          redirect: "follow",
        });
        if (response.ok) {
          const text = await response.text();
          const urlMatches = text.match(/<loc>(.*?)<\/loc>/g);
          if (urlMatches) {
            for (const match of urlMatches) {
              const url = match.replace(/<\/?loc>/g, "").trim();
              if (url && areSameDomain(url, pageUrl)) {
                urls.push(url);
              }
            }
          }
          break;
        }
      } catch { /* continue */ }
    }

    return urls.slice(0, 200);
  }

  shouldFollowUrl(url: string, entryUrl: string): boolean {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) return false;

      if (!areSameDomain(url, entryUrl)) return false;

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

      const pathname = parsed.pathname.toLowerCase();
      if (/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(pathname)) return false;

      return true;
    } catch {
      return false;
    }
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
}

export const siteDiscovery = new SiteDiscoveryEngine();
