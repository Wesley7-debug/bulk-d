import { NextRequest, NextResponse } from "next/server";
import { crawlOnly } from "../../../crawler/index";
import { isValidUrl } from "../../../lib/utils";
import { createJob, setCrawlResult, setJobError, emitEvent } from "../../../lib/job-store";
import { generateJobId } from "../../../lib/logger";
import { CrawlEvent, DiscoveredFile } from "../../../types";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url } = body;

    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    if (!isValidUrl(url)) {
      return NextResponse.json({ error: "Invalid URL format" }, { status: 400 });
    }

    const jobId = generateJobId();
    createJob(jobId, url);

    emitEvent(jobId, {
      type: "crawl_started",
      jobId,
      message: `Starting crawl of ${new URL(url).hostname}`,
    } as CrawlEvent);

    crawlOnly(url, jobId)
      .then((result) => {
        setCrawlResult(jobId, result);
        emitEvent(jobId, {
          type: "crawl_complete",
          jobId,
          total: result.files.filter((f: DiscoveredFile) => f.downloadable).length,
          crawlResult: result,
          message: `Crawl complete. ${result.files.filter((f: DiscoveredFile) => f.downloadable).length} episodes found.`,
        } as CrawlEvent);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Crawl failed";
        setJobError(jobId, msg);
        emitEvent(jobId, {
          type: "crawl_failed",
          jobId,
          message: msg,
        } as CrawlEvent);
      });

    return NextResponse.json({ jobId, status: "crawling" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Crawl failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
