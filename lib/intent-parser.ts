import { UserIntent } from "../types";

const SEASON_PATTERNS = [
  /season[\s._-]*(\d+)/i,
  /s(\d+)/i,
  /part[\s._-]*(\d+)/i,
  /vol(?:ume)?[\s._-]*(\d+)/i,
];

const EPISODE_RANGE_PATTERNS = [
  /ep(?:isodes?)?[\s._-]*(\d+)[\s._-]*(?:to|-|through)[\s._-]*(\d+)/i,
  /(\d+)[\s._-]*(?:to|-|through)[\s._-]*(\d+)/,
];

const QUALITY_PATTERNS = [
  /\b(1080p|720p|480p|360p)\b/i,
  /\b(hd|sd|uhd|4k)\b/i,
];

const TITLE_CLEANUP = [
  /\bwatch\b/i,
  /\bfull\b/i,
  /\bfree\b/i,
  /\bonline\b/i,
  /\bstream\b/i,
  /\bdownload\b/i,
  /\b season\b.*$/i,
  /\b s\d+.*$/i,
  /\b part\b.*$/i,
];

export function parseUserIntent(input: string): UserIntent {
  const trimmed = input.trim();
  const isUrl = isValidUrl(trimmed);

  let query: string | null = null;
  let sourceUrl: string = "";
  let requestedTitle: string | null = null;
  let requestedSeason: string | null = null;
  let requestedEpisodeRange: string | null = null;
  let requestedQuality: string | null = null;
  let derivedTitle: string | null = null;

  if (isUrl) {
    sourceUrl = trimmed;
    derivedTitle = extractTitleFromUrl(trimmed);
  } else {
    query = trimmed;
    sourceUrl = "";
    requestedTitle = extractTitleFromQuery(trimmed);
  }

  requestedSeason = extractSeason(trimmed);
  requestedEpisodeRange = extractEpisodeRange(trimmed);
  requestedQuality = extractQuality(trimmed);

  return {
    query,
    sourceUrl,
    requestedTitle,
    requestedSeason,
    requestedEpisodeRange,
    requestedQuality,
    derivedTitle,
  };
}

function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function extractTitleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    const last = segments[segments.length - 1];
    const cleaned = last
      .replace(/[-_]/g, " ")
      .replace(/\.(html?|php|aspx?|jsp)$/i, "")
      .replace(/\b(s\d+|season\d+|ep\d+|episode\d+)\b/gi, "")
      .replace(/\bid\d+\b/gi, "")
      .replace(/\b\d{5,}\b/g, "")
      .trim();
    if (cleaned.length < 2) return null;
    return cleaned
      .split(" ")
      .filter((w) => w.length > 0)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  } catch {
    return null;
  }
}

function extractTitleFromQuery(query: string): string {
  let title = query;
  for (const pattern of TITLE_CLEANUP) {
    title = title.replace(pattern, "");
  }
  title = title.replace(/\b(s\d+e\d+)\b/gi, "").trim();
  if (title.length < 2) return query;
  return title;
}

function extractSeason(text: string): string | null {
  for (const pattern of SEASON_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractEpisodeRange(text: string): string | null {
  for (const pattern of EPISODE_RANGE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return `${match[1]}-${match[2]}`;
  }
  return null;
}

function extractQuality(text: string): string | null {
  for (const pattern of QUALITY_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const q = match[1].toLowerCase();
      if (q === "hd") return "720p";
      if (q === "sd") return "480p";
      if (q === "uhd" || q === "4k") return "1080p";
      return q;
    }
  }
  return null;
}
