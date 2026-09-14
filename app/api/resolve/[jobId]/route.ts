import { NextRequest, NextResponse } from "next/server";
import { getJob, setJobEpisodes } from "../../../../lib/job-store";
import { resolveEpisodes } from "../../../../lib/resolution-manager";
import { logger } from "../../../../lib/logger";

const activeResolutions = new Map<string, Promise<{ resolved: number; failed: number }>>();

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const job = getJob(jobId);

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  if (job.status !== ("ready" as string)) {
    if (job.status === "resolving" || job.status === "completed") {
      return NextResponse.json({ jobId, status: job.status, message: "Resolution already in progress or completed" });
    }
    return NextResponse.json({ error: `Job is in '${job.status}' state. Expected 'ready'.` }, { status: 400 });
  }

  if (activeResolutions.has(jobId)) {
    return NextResponse.json({ jobId, status: "resolving", message: "Resolution already in progress" });
  }

  if (!job.result) {
    return NextResponse.json({ error: "No crawl result available" }, { status: 400 });
  }

  setJobEpisodes(jobId, job.result.files);

  const files = job.result.files;
  logger.log(jobId, "RESOLVE_START", `starting resolution for ${files.filter((f) => f.downloadable).length} episodes`);

  const promise = resolveEpisodes(jobId, files);
  activeResolutions.set(jobId, promise);

  promise.finally(() => {
    activeResolutions.delete(jobId);
  });

  return NextResponse.json({ jobId, status: "resolving", total: files.filter((f) => f.downloadable).length });
}
