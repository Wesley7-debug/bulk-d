import * as cheerio from "cheerio";
import { DiscoveredFile, FileType, Quality, DiscoveryMethod } from "../types";
import { guessFileType, guessMimeType, normalizeUrl } from "../lib/utils";
import { MEDIA_EXTENSIONS } from "../lib/constants";

class DiscoveryEngine {
  async findDownloadableResources(
    $: cheerio.CheerioAPI,
    baseUrl: string
  ): Promise<DiscoveredFile[]> {
    const candidates: DiscoveredFile[] = [];

    candidates.push(...this.extractMetaResources($, baseUrl));
    candidates.push(...this.extractJsonLdResources($, baseUrl));
    candidates.push(...this.extractDownloadAttributes($, baseUrl));
    candidates.push(...this.extractMediaElements($, baseUrl));
    candidates.push(...this.extractMediaLinks($, baseUrl));
    candidates.push(...this.extractAnchorLinks($, baseUrl));
    candidates.push(...this.extractIframeSources($, baseUrl));
    candidates.push(...this.extractSourceElements($, baseUrl));
    candidates.push(...this.extractObjectEmbeds($, baseUrl));
    candidates.push(...this.extractScriptInjectedUrls($, baseUrl));

    const seen = new Set<string>();
    const unique: DiscoveredFile[] = [];
    for (const file of candidates) {
      const normalizedUrl = this.normalizeUrlSafe(file.url, baseUrl);
      if (!normalizedUrl) continue;
      if (seen.has(normalizedUrl)) continue;
      seen.add(normalizedUrl);
      unique.push({ ...file, url: normalizedUrl });
    }

    return unique;
  }

  private extractMetaResources($: cheerio.CheerioAPI, baseUrl: string): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];

    const metaSelectors = [
      { selector: 'meta[property="og:video"]', type: "video" as FileType, method: "meta-tags" as DiscoveryMethod },
      { selector: 'meta[property="og:video:url"]', type: "video" as FileType, method: "meta-tags" as DiscoveryMethod },
      { selector: 'meta[property="og:video:secure_url"]', type: "video" as FileType, method: "meta-tags" as DiscoveryMethod },
      { selector: 'meta[property="og:audio"]', type: "audio" as FileType, method: "meta-tags" as DiscoveryMethod },
      { selector: 'meta[property="og:audio:url"]', type: "audio" as FileType, method: "meta-tags" as DiscoveryMethod },
      { selector: 'meta[name="twitter:player:stream"]', type: "video" as FileType, method: "meta-tags" as DiscoveryMethod },
      { selector: 'meta[name="twitter:player"]', type: "video" as FileType, method: "meta-tags" as DiscoveryMethod },
      { selector: 'meta[itemprop="embedUrl"]', type: "video" as FileType, method: "meta-tags" as DiscoveryMethod },
      { selector: 'meta[itemprop="contentUrl"]', type: "video" as FileType, method: "meta-tags" as DiscoveryMethod },
    ];

    for (const { selector, type, method } of metaSelectors) {
      $(selector).each((_, el) => {
        const content = $(el).attr("content");
        if (content) {
          const resolved = this.resolveUrl(content, baseUrl);
          if (resolved) {
            files.push(this.createFileEntry(resolved, baseUrl, type, method));
          }
        }
      });
    }

    return files;
  }

  private extractJsonLdResources($: cheerio.CheerioAPI, baseUrl: string): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html() || "");
        this.extractFromJsonLd(data, files, baseUrl);
      } catch {
        // Invalid JSON, skip
      }
    });

    return files;
  }

  private extractFromJsonLd(
    data: Record<string, unknown>,
    files: DiscoveredFile[],
    baseUrl: string
  ): void {
    if (data.contentUrl) {
      const url = this.resolveUrl(String(data.contentUrl), baseUrl);
      if (url) files.push(this.createFileEntry(url, baseUrl, "video", "json-ld"));
    }
    if (data.embedUrl) {
      const url = this.resolveUrl(String(data.embedUrl), baseUrl);
      if (url) files.push(this.createFileEntry(url, baseUrl, "video", "json-ld"));
    }
    if (Array.isArray(data.encoding)) {
      for (const item of data.encoding) {
        if (item.contentUrl) {
          const url = this.resolveUrl(String(item.contentUrl), baseUrl);
          if (url) files.push(this.createFileEntry(url, baseUrl, "video", "json-ld"));
        }
      }
    }
    if (data.hasPart && Array.isArray(data.hasPart)) {
      for (const part of data.hasPart) {
        if (part.contentUrl) {
          const url = this.resolveUrl(String(part.contentUrl), baseUrl);
          if (url) files.push(this.createFileEntry(url, baseUrl, "video", "json-ld"));
        }
      }
    }
    if (data["@type"] === "VideoObject") {
      if (data.contentUrl) {
        const url = this.resolveUrl(String(data.contentUrl), baseUrl);
        if (url) files.push(this.createFileEntry(url, baseUrl, "video", "json-ld"));
      }
      if (data.thumbnailUrl) {
        const last = files[files.length - 1];
        if (last) last.thumbnailUrl = String(data.thumbnailUrl);
      }
    }
    if (data["@type"] === "AudioObject") {
      if (data.contentUrl) {
        const url = this.resolveUrl(String(data.contentUrl), baseUrl);
        if (url) files.push(this.createFileEntry(url, baseUrl, "audio", "json-ld"));
      }
    }
    if (data["@type"] === "ImageObject") {
      if (data.contentUrl) {
        const url = this.resolveUrl(String(data.contentUrl), baseUrl);
        if (url) files.push(this.createFileEntry(url, baseUrl, "image", "json-ld"));
      }
    }
  }

  private extractDownloadAttributes($: cheerio.CheerioAPI, baseUrl: string): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];

    $("[download]").each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        const resolved = this.resolveUrl(href, baseUrl);
        if (resolved) {
          const type = guessFileType(resolved);
          files.push(this.createFileEntry(resolved, baseUrl, type, "download-attribute"));
        }
      }
    });

    return files;
  }

  private extractMediaElements($: cheerio.CheerioAPI, baseUrl: string): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];

    $("video source[src], video[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (src) {
        const resolved = this.resolveUrl(src, baseUrl);
        if (resolved) {
          const entry = this.createFileEntry(resolved, baseUrl, "video", "media-elements");
          const poster = $(el).closest("video").attr("poster");
          if (poster) {
            const posterUrl = this.resolveUrl(poster, baseUrl);
            if (posterUrl) entry.thumbnailUrl = posterUrl;
          }
          files.push(entry);
        }
      }
    });

    $("audio source[src], audio[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (src) {
        const resolved = this.resolveUrl(src, baseUrl);
        if (resolved) {
          files.push(this.createFileEntry(resolved, baseUrl, "audio", "media-elements"));
        }
      }
    });

    return files;
  }

  private extractMediaLinks($: cheerio.CheerioAPI, baseUrl: string): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];
    const extPattern = Object.keys(MEDIA_EXTENSIONS).join("|");
    const mediaExtensions = new RegExp(`\\.(${extPattern})(\\?[^"\\s]*)?$`, "i");

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (href && mediaExtensions.test(href)) {
        const resolved = this.resolveUrl(href, baseUrl);
        if (resolved) {
          const type = guessFileType(resolved);
          const name = this.extractNameFromUrl(resolved);
          const entry: DiscoveredFile = {
            url: resolved,
            name,
            fileType: type,
            mimeType: guessMimeType(resolved),
            downloadable: false,
            discoveryMethod: "media-links",
          };
          const linkText = $(el).text().trim();
          const quality = this.guessQualityFromText(linkText) || this.guessQualityFromUrl(resolved);
          if (quality) entry.quality = quality;
          const parent = $(el).parent();
          const nearestImg = parent.find("img").first().attr("src") ||
            $(el).find("img").first().attr("src");
          if (nearestImg) {
            const imgUrl = this.resolveUrl(nearestImg, baseUrl);
            if (imgUrl) entry.thumbnailUrl = imgUrl;
          }
          files.push(entry);
        }
      }
    });

    return files;
  }

  private extractAnchorLinks($: cheerio.CheerioAPI, baseUrl: string): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      const download = $(el).attr("download");
      if (href && download) {
        const resolved = this.resolveUrl(href, baseUrl);
        if (resolved) {
          const type = guessFileType(resolved);
          const name = download || this.extractNameFromUrl(resolved);
          files.push({
            url: resolved,
            name,
            fileType: type,
            mimeType: guessMimeType(resolved),
            downloadable: false,
            discoveryMethod: "anchor-links",
          });
        }
      }
    });

    return files;
  }

  private extractIframeSources($: cheerio.CheerioAPI, baseUrl: string): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];

    $("iframe[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (src) {
        const resolved = this.resolveUrl(src, baseUrl);
        if (resolved) {
          const entry = this.createFileEntry(resolved, baseUrl, "video", "iframe-src");
          entry.mimeType = "text/html";
          files.push(entry);
        }
      }
    });

    return files;
  }

  private extractSourceElements($: cheerio.CheerioAPI, baseUrl: string): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];

    $("source[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (src) {
        const resolved = this.resolveUrl(src, baseUrl);
        if (resolved) {
          const typeAttr = $(el).attr("type") || "";
          let fileType: FileType = "other";
          if (typeAttr.startsWith("video/")) fileType = "video";
          else if (typeAttr.startsWith("audio/")) fileType = "audio";
          else if (typeAttr.startsWith("image/")) fileType = "image";
          else fileType = guessFileType(resolved);
          files.push(this.createFileEntry(resolved, baseUrl, fileType, "source-element"));
        }
      }
    });

    return files;
  }

  private extractObjectEmbeds($: cheerio.CheerioAPI, baseUrl: string): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];

    $("object[data], embed[src]").each((_, el) => {
      const data = $(el).attr("data") || $(el).attr("src");
      if (data) {
        const resolved = this.resolveUrl(data, baseUrl);
        if (resolved) {
          files.push(this.createFileEntry(resolved, baseUrl, "video", "object-embed"));
        }
      }
    });

    return files;
  }

  private extractScriptInjectedUrls($: cheerio.CheerioAPI, baseUrl: string): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];
    const mediaUrlPattern = /https?:\/\/[^\s"'<>]+\.(mp4|webm|mkv|avi|mov|mp3|wav|flac|m4a|ogg)(\?[^\s"'<>]*)?/gi;

    $("script").each((_, el) => {
      const text = $(el).html() || "";
      let match;
      while ((match = mediaUrlPattern.exec(text)) !== null) {
        const url = match[0];
        const resolved = this.resolveUrl(url, baseUrl);
        if (resolved) {
          const type = guessFileType(resolved);
          files.push(this.createFileEntry(resolved, baseUrl, type, "script-injected"));
        }
      }
    });

    return files;
  }

  private createFileEntry(
    url: string,
    baseUrl: string,
    fileType: FileType,
    method: DiscoveryMethod
  ): DiscoveredFile {
    return {
      url,
      name: this.extractNameFromUrl(url),
      fileType,
      mimeType: guessMimeType(url),
      downloadable: false,
      discoveryMethod: method,
    };
  }

  private extractNameFromUrl(url: string): string {
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

  private guessQualityFromUrl(url: string): Quality | undefined {
    const lower = url.toLowerCase();
    if (lower.includes("1080") || lower.includes("1080p")) return "1080p";
    if (lower.includes("720") || lower.includes("720p")) return "720p";
    if (lower.includes("480") || lower.includes("480p")) return "480p";
    if (lower.includes("360") || lower.includes("360p")) return "360p";
    return undefined;
  }

  private guessQualityFromText(text: string): Quality | undefined {
    const lower = text.toLowerCase();
    if (lower.includes("1080p") || lower.includes("1080")) return "1080p";
    if (lower.includes("720p") || lower.includes("720")) return "720p";
    if (lower.includes("480p") || lower.includes("480")) return "480p";
    if (lower.includes("360p") || lower.includes("360")) return "360p";
    if (lower.includes("hd")) return "720p";
    if (lower.includes("sd")) return "480p";
    return undefined;
  }

  private resolveUrl(url: string, baseUrl: string): string | null {
    try {
      return new URL(url, baseUrl).href;
    } catch {
      return null;
    }
  }

  private normalizeUrlSafe(url: string, baseUrl: string): string | null {
    try {
      return normalizeUrl(url, baseUrl);
    } catch {
      return null;
    }
  }
}

export const discovery = new DiscoveryEngine();
