import { NextRequest, NextResponse } from "next/server";
import { getJob, getEventHistory } from "../../../../lib/job-store";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const job = getJob(jobId);

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const events = getEventHistory(jobId);

  return NextResponse.json({
    jobId: job.jobId,
    status: job.status,
    originalUrl: job.originalUrl,
    total: job.total,
    current: job.current,
    createdAt: job.createdAt,
    hasResult: !!job.result,
    result: job.result
      ? {
          title: job.result.title,
          status: job.result.status,
          files: job.result.files,
          statistics: job.result.statistics,
          crawl: job.result.crawl,
          warnings: job.result.warnings,
        }
      : null,
    events,
  });
}
