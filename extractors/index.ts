import * as cheerio from "cheerio";
import { DiscoveredFile, Quality } from "../types";
import { guessFileType, guessMimeType, extractEpisodeNumber, normalizeUrl } from "../lib/utils";
import { MEDIA_EXTENSIONS } from "../lib/constants";

class ExtractorEngine {
  extractNameFromUrl(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      const segments = pathname.split("/").filter(Boolean);
      const last = segments[segments.length - 1] || "unnamed";
      return decodeURIComponent(last)
        .replace(/\.[^.]+$/, "")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    } catch {
      return "unnamed";
    }
  }

  guessMimeType(url: string): string {
    return guessMimeType(url);
  }

  extractEpisodeNumber(name: string): number | null {
    return extractEpisodeNumber(name);
  }

  cleanFileName(name: string): string {
    return name
      .replace(/[<>:"/\\|?*]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 200);
  }

  extractAllLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
    const links: string[] = [];
    const seen = new Set<string>();

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      try {
        const normalized = normalizeUrl(href, baseUrl);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          links.push(normalized);
        }
      } catch {
        // Skip invalid URLs
      }
    });

    return links;
  }

  extractPageMetadata($: cheerio.CheerioAPI): Record<string, string> {
    const metadata: Record<string, string> = {};

    $('meta[property="og:title"]').each((_, el) => {
      metadata["og:title"] = $(el).attr("content") || "";
    });
    $('meta[property="og:description"]').each((_, el) => {
      metadata["og:description"] = $(el).attr("content") || "";
    });
    $('meta[property="og:image"]').each((_, el) => {
      metadata["og:image"] = $(el).attr("content") || "";
    });
    $('meta[property="og:type"]').each((_, el) => {
      metadata["og:type"] = $(el).attr("content") || "";
    });
    $('meta[property="og:url"]').each((_, el) => {
      metadata["og:url"] = $(el).attr("content") || "";
    });
    $('meta[name="description"]').each((_, el) => {
      metadata["description"] = $(el).attr("content") || "";
    });
    $('meta[name="author"]').each((_, el) => {
      metadata["author"] = $(el).attr("content") || "";
    });
    $('link[rel="canonical"]').each((_, el) => {
      metadata["canonical"] = $(el).attr("href") || "";
    });

    return metadata;
  }

  extractJsonLdData($: cheerio.CheerioAPI): Record<string, unknown>[] {
    const data: Record<string, unknown>[] = [];

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const parsed = JSON.parse($(el).html() || "");
        data.push(parsed);
      } catch {
        // Skip invalid JSON
      }
    });

    return data;
  }

  extractVideoSources($: cheerio.CheerioAPI, baseUrl: string): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];

    $("video source, video").each((_, el) => {
      const src = $(el).attr("src");
      if (src) {
        const entry: DiscoveredFile = {
          url: normalizeUrl(src, baseUrl),
          name: this.extractNameFromUrl(src),
          fileType: "video",
          mimeType: $(el).attr("type") || guessMimeType(src),
          downloadable: false,
        };
        const type = $(el).attr("type");
        if (type) entry.mimeType = type;
        files.push(entry);
      }
    });

    return files;
  }

  extractAudioSources($: cheerio.CheerioAPI, baseUrl: string): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];

    $("audio source, audio").each((_, el) => {
      const src = $(el).attr("src");
      if (src) {
        files.push({
          url: normalizeUrl(src, baseUrl),
          name: this.extractNameFromUrl(src),
          fileType: "audio",
          mimeType: $(el).attr("type") || guessMimeType(src),
          downloadable: false,
        });
      }
    });

    return files;
  }

  extractDownloadLinks($: cheerio.CheerioAPI, baseUrl: string): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];
    const extPattern = Object.keys(MEDIA_EXTENSIONS).join("|");
    const mediaRegex = new RegExp(`\\.(${extPattern})(\\?[^"\\s]*)?$`, "i");

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      const hasDownload = $(el).attr("download") !== undefined;
      const isMedia = mediaRegex.test(href);

      if (hasDownload || isMedia) {
        const type = guessFileType(href);
        const entry: DiscoveredFile = {
          url: normalizeUrl(href, baseUrl),
          name: this.extractNameFromUrl(href),
          fileType: type,
          mimeType: guessMimeType(href),
          downloadable: false,
        };
        const quality = this.guessQualityFromUrl(href);
        if (quality) entry.quality = quality;
        files.push(entry);
      }
    });

    return files;
  }

  private guessQualityFromUrl(url: string): Quality | undefined {
    const lower = url.toLowerCase();
    const match = lower.match(/\b(\d{3,4})p\b/);
    if (match) return `${match[1]}p`;
    if (lower.includes("4k") || lower.includes("2160")) return "2160p";
    return undefined;
  }
}

export const extractors = new ExtractorEngine();
