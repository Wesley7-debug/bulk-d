import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { ErrorState } from "../types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 200);
}

export function generateJobId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function getProgressPercent(completed: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((completed / total) * 100);
}

export function normalizeUrl(url: string, baseUrl?: string): string {
  try {
    const resolved = baseUrl ? new URL(url, baseUrl) : new URL(url);
    resolved.hash = "";
    let normalized = resolved.href;
    normalized = normalized.replace(/\/+$/, "");
    if (normalized === "") normalized = resolved.origin;
    return normalized;
  } catch {
    return url;
  }
}

export function extractRegistrableDomain(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  const tld = parts[parts.length - 1];
  const secondLevel = parts[parts.length - 2];
  const ignored = ["co", "com", "org", "net", "gov", "edu", "ac"];
  if (ignored.includes(secondLevel) && parts.length > 2) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

export function areSameDomain(url1: string, url2: string): boolean {
  try {
    const domain1 = extractRegistrableDomain(new URL(url1).hostname);
    const domain2 = extractRegistrableDomain(new URL(url2).hostname);
    return domain1 === domain2;
  } catch {
    return false;
  }
}

export function getBaseDomain(url: string): string {
  try {
    return extractRegistrableDomain(new URL(url).hostname);
  } catch {
    return "";
  }
}

export function mapHttpStatusToErrorState(status: number): ErrorState {
  if (status === 401 || status === 403) return "ACCESS_BLOCKED";
  if (status === 404) return "NOT_DOWNLOADABLE";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_ERROR";
  return "UNKNOWN";
}

export function mapErrorToErrorState(error: Error): ErrorState {
  const msg = error.message.toLowerCase();
  if (msg.includes("timeout") || msg.includes("aborted")) return "TIMEOUT";
  if (msg.includes("401") || msg.includes("403")) return "ACCESS_BLOCKED";
  if (msg.includes("404")) return "NOT_DOWNLOADABLE";
  if (msg.includes("429")) return "RATE_LIMITED";
  if (msg.includes("500") || msg.includes("502") || msg.includes("503"))
    return "SERVER_ERROR";
  if (msg.includes("enotfound") || msg.includes("econnrefused"))
    return "SERVER_ERROR";
  return "UNKNOWN";
}

export function naturalSort(a: string, b: string): number {
  const ax: (string | number)[] = [];
  const bx: (string | number)[] = [];
  a.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
    ax.push($1 ? parseInt($1, 10) : $2);
    return "";
  });
  b.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
    bx.push($1 ? parseInt($1, 10) : $2);
    return "";
  });
  while (ax.length && bx.length) {
    const an = ax.shift();
    const bn = bx.shift();
    const isNumA = typeof an === "number";
    const isNumB = typeof bn === "number";
    if (isNumA && isNumB) {
      if ((an as number) !== (bn as number)) return (an as number) - (bn as number);
    } else if (isNumA || isNumB) {
      return isNumA ? -1 : 1;
    } else {
      const cmp = String(an).localeCompare(String(bn));
      if (cmp !== 0) return cmp;
    }
  }
  return ax.length - bx.length;
}

export function guessFileType(url: string): "video" | "audio" | "image" | "document" | "archive" | "other" {
  const ext = url.split(".").pop()?.split("?")[0]?.toLowerCase() || "";
  if (["mp4", "webm", "mkv", "avi", "mov", "flv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "flac", "m4a", "aac"].includes(ext)) return "audio";
  if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["pdf", "doc", "docx", "txt"].includes(ext)) return "document";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "archive";
  return "other";
}

export function guessMimeType(url: string): string {
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
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    zip: "application/zip",
  };
  return mimeMap[ext] || "application/octet-stream";
}

export function extractEpisodeNumber(name: string): number | null {
  const patterns = [
    /ep(?:isode)?[\s._-]*(\d+)/i,
    /s\d+e(\d+)/i,
    /[\s._-](\d+)[\s._-]/,
    /\((\d+)\)/,
    /^(\d+)[\s._-]/,
  ];
  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}
