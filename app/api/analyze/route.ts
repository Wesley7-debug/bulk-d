import { NextRequest, NextResponse } from "next/server";
import { analyzeUrl } from "../../../crawler/index";
import { isValidUrl } from "../../../lib/utils";
import { parseUserIntent } from "../../../lib/intent-parser";

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
    name: "NaijaVault",
    buildUrl: (title, season) => {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return `https://www.naijavault.com/${slug}-season-${season}-complete/`;
    },
  },
  {
    name: "9jarocks",
    buildUrl: (title, season) => {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return `https://9jarocks.net/videodownload/${slug}-season-${season}-complete.html`;
    },
  },
  {
    name: "Waploaded",
    buildUrl: (title, season) => {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const sNum = season.replace(/^0/, "");
      return `https://shows.waploaded.com/series/${slug}-season-${sNum}`;
    },
  },
];

function extractFallbackInfo(url: string, resultTitle: string | null) {
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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, search } = body;

    if (!url && !search) {
      return NextResponse.json(
        { error: "URL is required" },
        { status: 400 }
      );
    }

    if (search && !url) {
      return NextResponse.json(
        {
          success: true,
          type: "search",
          data: {
            query: search,
            results: [],
            totalResults: 0,
            message: "Search is coming soon. Please provide a direct URL for now.",
          },
        },
        { status: 200 }
      );
    }

    if (url) {
      if (!isValidUrl(url)) {
        return NextResponse.json(
          {
            success: true,
            type: "analysis",
            data: {
              jobId: "invalid",
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
              message: "Invalid URL format. Please provide a valid http or https URL.",
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
            },
          },
          { status: 200 }
        );
      }

      try {
        const result = await analyzeUrl(url);

        const hasResults = result.status === "MEDIA_FOUND" && result.files.some((f) => f.downloadable);

        if (hasResults) {
          return NextResponse.json({
            success: true,
            type: "analysis",
            data: result,
          });
        }

        const { title: showTitle, season } = extractFallbackInfo(url, result.title);

        if (!showTitle || showTitle.length < 2) {
          return NextResponse.json({
            success: true,
            type: "analysis",
            data: {
              ...result,
              warnings: [
                ...result.warnings,
                {
                  code: "NO_FALLBACK",
                  message: "Could not determine show title for fallback search.",
                },
              ],
            },
          });
        }

        const fallbackResults: Array<{ name: string; url: string; result: any }> = [];

        const fallbackPromises = FALLBACK_SITES.map(async (site) => {
          const fallbackUrl = site.buildUrl(showTitle, season);
          if (!fallbackUrl) return null;
          try {
            const fallbackResult = await analyzeUrl(fallbackUrl);
            const hasFallbackResults =
              fallbackResult.status === "MEDIA_FOUND" &&
              fallbackResult.files.some((f) => f.downloadable);
            if (hasFallbackResults) {
              return { name: site.name, url: fallbackUrl, result: fallbackResult };
            }
          } catch {
            // ignore fallback errors
          }
          return null;
        });

        const settled = await Promise.allSettled(fallbackPromises);
        for (const s of settled) {
          if (s.status === "fulfilled" && s.value) {
            fallbackResults.push(s.value);
          }
        }

        if (fallbackResults.length > 0) {
          const best = fallbackResults[0];
          return NextResponse.json({
            success: true,
            type: "analysis",
            data: {
              ...best.result,
              originalUrl: url,
              warnings: [
                ...(result.warnings || []),
                {
                  code: "FALLBACK_USED",
                  message: `No results found on ${new URL(url).hostname}. Found ${best.result.files.filter((f: any) => f.downloadable).length} file(s) on ${best.name} instead.`,
                },
              ],
            },
          });
        }

        const triedSites = FALLBACK_SITES.map((s) => s.name).join(", ");
        return NextResponse.json({
          success: true,
          type: "analysis",
          data: {
            ...result,
            warnings: [
              ...(result.warnings || []),
              {
                code: "NO_FALLBACK_RESULTS",
                message: `No downloadable content found on this site or fallback sources (${triedSites}). The content may be behind authentication, dynamically loaded, or not available.`,
              },
            ],
          },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Analysis failed";
        console.error("Analysis error:", message);

        return NextResponse.json({
          success: true,
          type: "analysis",
          data: {
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
            message: `Analysis failed: ${message}`,
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
          },
        });
      }
    }

    return NextResponse.json(
      { error: "URL is required" },
      { status: 400 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed";
    console.error("Analysis error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
