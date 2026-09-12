import { CRAWL_MAX_DEPTH, CRAWL_MAX_PAGES, CRAWL_TIMEOUT_MS } from "../lib/constants";

export interface CrawlPolicy {
  maxDepth: number;
  maxPages: number;
  timeoutMs: number;
  sameDomainOnly: boolean;
  allowedExtensions: string[];
  blockedExtensions: string[];
  urlFilter?: (url: string) => boolean;
}

export function createCrawlPolicy(overrides?: Partial<CrawlPolicy>): CrawlPolicy {
  return {
    maxDepth: CRAWL_MAX_DEPTH,
    maxPages: CRAWL_MAX_PAGES,
    timeoutMs: CRAWL_TIMEOUT_MS,
    sameDomainOnly: true,
    allowedExtensions: [
      "mp4", "webm", "mkv", "avi", "mov", "flv",
      "mp3", "wav", "ogg", "flac", "m4a", "aac",
      "jpg", "jpeg", "png", "gif", "webp",
      "pdf", "doc", "docx", "txt",
      "zip", "rar", "7z", "tar", "gz",
    ],
    blockedExtensions: ["exe", "bat", "cmd", "sh", "ps1", "msi", "dll", "js", "css"],
    ...overrides,
  };
}

export function shouldCrawlUrl(
  url: string,
  entryDomain: string,
  visited: Set<string>,
  policy: CrawlPolicy
): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    if (visited.has(url)) return false;
    const ext = parsed.pathname.split(".").pop()?.toLowerCase() || "";
    if (policy.blockedExtensions.includes(ext)) return false;
    if (policy.sameDomainOnly) {
      const hostParts = parsed.hostname.split(".");
      const entryParts = entryDomain.split(".");
      const urlDomain = hostParts.slice(-2).join(".");
      const entryD = entryParts.slice(-2).join(".");
      if (urlDomain !== entryD) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isMediaUrl(url: string): boolean {
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase() || "";
    const mediaExts = [
      "mp4", "webm", "mkv", "avi", "mov", "flv",
      "mp3", "wav", "ogg", "flac", "m4a", "aac",
      "jpg", "jpeg", "png", "gif", "webp",
      "pdf", "zip", "rar", "7z",
    ];
    return mediaExts.includes(ext);
  } catch {
    return false;
  }
}

export function isPageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const ext = parsed.pathname.split(".").pop()?.toLowerCase() || "";
    const nonPageExts = [
      "mp4", "webm", "mkv", "avi", "mov", "flv",
      "mp3", "wav", "ogg", "flac", "m4a", "aac",
      "jpg", "jpeg", "png", "gif", "webp", "svg",
      "pdf", "zip", "rar", "7z", "tar", "gz",
      "js", "css", "json", "xml", "txt",
      "ico", "woff", "woff2", "ttf", "eot",
    ];
    return !nonPageExts.includes(ext);
  } catch {
    return false;
  }
}
