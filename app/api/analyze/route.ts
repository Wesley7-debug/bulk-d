import { NextRequest, NextResponse } from "next/server";
import { analyzeUrl, searchAndAnalyze } from "../../../crawler/index";
import { auth } from "../../../auth";
import { connectToDatabase } from "../../../lib/mongodb";
import { isValidUrl } from "../../../lib/utils";
import { logger } from "../../../lib/logger";

export async function POST(request: NextRequest) {
  try {
    await auth();
    await connectToDatabase();

    const body = await request.json();
    const { url, search } = body;

    if (!url && !search) {
      return NextResponse.json(
        { error: "Either URL or search query is required" },
        { status: 400 }
      );
    }

    if (search && !url) {
      try {
        const searchResponse = await searchAndAnalyze(search, 10);
        return NextResponse.json({
          success: true,
          type: "search",
          data: searchResponse,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Search failed";
        logger.log("search", "RESULT", message);
        return NextResponse.json({ error: message }, { status: 500 });
      }
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
        return NextResponse.json({
          success: true,
          type: "analysis",
          data: result,
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
      { error: "Either URL or search query is required" },
      { status: 400 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed";
    console.error("Analysis error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
