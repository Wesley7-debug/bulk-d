import { analyzeUrl } from "../crawler/index";
import { DiscoveredFile, AnalysisResult } from "../types";
import { parseUserIntent } from "./intent-parser";

export interface SpeedTestCandidate {
  name: string;
  buildUrl: (title: string, season: string, episode?: string) => string | null;
}

export interface SpeedTestSiteResult {
  name: string;
  status: "pending" | "resolving" | "resolved" | "failed";
  responseTimeMs?: number;
  url?: string;
}

export interface SpeedTestResult {
  winner: { name: string; url: string; responseTimeMs: number; result: AnalysisResult } | null;
  sites: SpeedTestSiteResult[];
}

const SPEED_TEST_CANDIDATES: SpeedTestCandidate[] = [
  {
    name: "Nkiri",
    buildUrl: (title, season) => {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const sNum = season.replace(/^0/, "");
      return `https://thenkiri.com/${slug}-s${sNum}-complete-tv-series/`;
    },
  },
  {
    name: "FzTVSeries",
    buildUrl: (title, season) => {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const sNum = season.replace(/^0/, "");
      return `https://fztvseries.com/${slug}-season-${sNum}-download/`;
    },
  },
  {
    name: "Waploaded",
    buildUrl: (title, season) => {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const sNum = season.replace(/^0/, "");
      return `https://waploaded.com/${slug}-season-${sNum}-tv-series/`;
    },
  },
];

function hasResults(r: AnalysisResult): boolean {
  return r.status === "MEDIA_FOUND" && r.files.some((f) => f.downloadable);
}

export async function runSpeedTest(
  originalUrl: string,
  onProgress?: (sites: SpeedTestSiteResult[]) => void
): Promise<SpeedTestResult> {
  const intent = parseUserIntent(originalUrl);
  const title = intent.derivedTitle || intent.requestedTitle || "";
  const season = intent.requestedSeason || "1";

  if (!title || title.length < 2) {
    return { winner: null, sites: [] };
  }

  const sites: SpeedTestSiteResult[] = SPEED_TEST_CANDIDATES.map((c) => ({
    name: c.name,
    status: "pending" as const,
  }));

  onProgress?.(sites);

  const promises = SPEED_TEST_CANDIDATES.map(async (candidate, idx) => {
    const targetUrl = candidate.buildUrl(title, season);
    if (!targetUrl) {
      sites[idx].status = "failed";
      onProgress?.(sites);
      return null;
    }

    sites[idx].url = targetUrl;
    sites[idx].status = "resolving";
    sites[idx].responseTimeMs = undefined;
    onProgress?.(sites);

    const start = Date.now();
    try {
      const result = await analyzeUrl(targetUrl);
      const elapsed = Date.now() - start;

      if (hasResults(result)) {
        sites[idx].status = "resolved";
        sites[idx].responseTimeMs = elapsed;
        onProgress?.(sites);
        return { name: candidate.name, url: targetUrl, responseTimeMs: elapsed, result };
      }

      sites[idx].status = "failed";
      sites[idx].responseTimeMs = elapsed;
      onProgress?.(sites);
      return null;
    } catch {
      sites[idx].status = "failed";
      sites[idx].responseTimeMs = Date.now() - start;
      onProgress?.(sites);
      return null;
    }
  });

  const winner = await Promise.any(promises.filter(Boolean) as Promise<{ name: string; url: string; responseTimeMs: number; result: AnalysisResult }[]>);

  return { winner, sites };
}
