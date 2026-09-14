import { NextRequest, NextResponse } from "next/server";
import { analyzeUrl } from "../../../crawler/index";
import { isValidUrl } from "../../../lib/utils";
import { parseUserIntent } from "../../../lib/intent-parser";
import { AnalysisResult } from "../../../types";

interface FallbackSite {
  name: string;
  buildUrl: (title: string, season: string) => string | null;
}

const FALLBACK_SITES: FallbackSite[] = [
  {
    name: "Nkiri",
    buildUrl: (title, season) => {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const sNum = season.replace(/^0/, "");
      return `https://thenkiri.com/${slug}-s${sNum}-complete-tv-series/`;
    },
  },
  {
    name: "FzMovies",
    buildUrl: (title, season) => {
      const slug = title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
      const sNum = season.replace(/^0/, "");
      return `https://fzmovies.video/search.php?searchterm=${encodeURIComponent(title)}+season+${sNum}`;
    },
  },
  {
    name: "9jarocks",
    buildUrl: (title, season) => {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return `https://9jarocks.net/videodownload/${slug}-season-${season}-complete.html`;
    },
  },
];

function extractShowInfo(url: string, resultTitle: string | null) {
  const intent = parseUserIntent(url);
  const title = resultTitle
    ? resultTitle.replace(/\s*\(complete\).*/i, "").trim()
    : intent.derivedTitle || intent.requestedTitle || "";
  const season = intent.requestedSeason || "1";
  const cleanTitle = title
    .replace(/\bseason\b.*$/i, "")
    .replace(/\bcomplete\b.*$/i, "")
    .replace(/\bdownload\b.*$/i, "")
    .replace(/\b\d{3,4}p\b/gi, "")
    .trim();
  return { title: cleanTitle, season };
}

function hasResults(r: AnalysisResult): boolean {
  return r.status === "MEDIA_FOUND" && r.files.some((f) => f.downloadable);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url } = body;

    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    if (!isValidUrl(url)) {
      return NextResponse.json({
        success: true,
        type: "analysis",
        data: buildErrorResult(url, "Invalid URL format. Please provide a valid http or https URL."),
      });
    }

    const originalResult = await analyzeUrl(url);

    if (hasResults(originalResult)) {
      return NextResponse.json({ success: true, type: "analysis", data: originalResult });
    }

    const { title: showTitle, season } = extractShowInfo(url, originalResult.title);

    if (!showTitle || showTitle.length < 2) {
      return NextResponse.json({ success: true, type: "analysis", data: originalResult });
    }

    const fallbackPromises = FALLBACK_SITES.map(async (site) => {
      const fallbackUrl = site.buildUrl(showTitle, season);
      if (!fallbackUrl) return null;
      try {
        const result = await analyzeUrl(fallbackUrl);
        if (hasResults(result)) {
          return { name: site.name, url: fallbackUrl, result };
        }
      } catch {}
      return null;
    });

    const settled = await Promise.allSettled(fallbackPromises);
    const winners = settled
      .filter((s) => s.status === "fulfilled" && s.value)
      .map((s) => (s as PromiseFulfilledResult<any>).value);

    if (winners.length > 0) {
      const best = winners[0];
      return NextResponse.json({
        success: true,
        type: "analysis",
        data: {
          ...best.result,
          originalUrl: url,
          warnings: [
            ...(originalResult.warnings || []),
            {
              code: "FALLBACK_USED",
              message: `No results on ${new URL(url).hostname}. Found ${best.result.files.filter((f: any) => f.downloadable).length} file(s) on ${best.name}.`,
            },
          ],
        },
      });
    }

    const triedSites = [new URL(url).hostname, ...FALLBACK_SITES.map((s) => s.name)].join(", ");
    return NextResponse.json({
      success: true,
      type: "analysis",
      data: {
        ...originalResult,
        warnings: [
          ...(originalResult.warnings || []),
          {
            code: "NO_FALLBACK_RESULTS",
            message: `No downloadable content found on ${triedSites}. The content may be behind authentication or not publicly available.`,
          },
        ],
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function buildErrorResult(url: string, message: string): AnalysisResult {
  return {
    jobId: "error",
    status: "BLOCKED",
    accessStatus: "UNKNOWN",
    domain: "",
    originalUrl: url,
    finalUrl: "",
    title: null,
    description: null,
    thumbnail: null,
    crawl: { pagesDiscovered: 0, pagesVisited: 0, pagesBlocked: 0, pagesFailed: 0 },
    files: [],
    statistics: { discovered: 0, downloadable: 0, inaccessible: 0, unsupported: 0, totalSize: 0 },
    availableQualities: [],
    message,
    details: {
      accessStatus: "UNKNOWN",
      httpStatus: null,
      finalUrl: "",
      contentType: null,
      contentLength: null,
      redirectCount: 0,
      robotsStatus: null,
      serverHeaders: {},
      tlsValid: false,
      dnsResolved: false,
      crawlStarted: false,
    },
    warnings: [],
  };
}
