import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import { connectToDatabase } from "../../../../../lib/mongodb";
import { Job } from "../../../../../db/models/Job";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await connectToDatabase();

    const { id } = await params;
    const job = await Job.findOne({ jobId: id, userId: session.user.id })
      .select(
        "jobId status totalFiles completedFiles failedFiles totalBytes downloadedBytes zipUrl zipSize error"
      )
      .lean();

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    return NextResponse.json({
      jobId: job.jobId,
      status: job.status,
      totalFiles: job.totalFiles,
      completedFiles: job.completedFiles,
      failedFiles: job.failedFiles,
      totalBytes: job.totalBytes,
      downloadedBytes: job.downloadedBytes,
      zipUrl: job.zipUrl,
      zipSize: job.zipSize,
      error: job.error,
    });
  } catch (error) {
    console.error("Error fetching progress:", error);
    return NextResponse.json(
      { error: "Failed to fetch progress" },
      { status: 500 }
    );
  }
}
