import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import { connectToDatabase } from "../../../../../lib/mongodb";
import { Job } from "../../../../../db/models/Job";
import { JobFile } from "../../../../../db/models/JobFile";

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

    const files = await JobFile.find({ jobId: id })
      .select("fileName url downloaded failed error quality")
      .lean();

    const fileDetails = files.map((f) => ({
      fileName: f.fileName,
      url: f.url,
      downloaded: f.downloaded,
      failed: f.failed,
      error: f.error || null,
      quality: f.quality,
    }));

    const failedFiles = fileDetails.filter((f) => f.failed);
    const succeededFiles = fileDetails.filter((f) => f.downloaded);

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
      files: fileDetails,
      failedFileDetails: failedFiles,
      succeededFileDetails: succeededFiles,
    });
  } catch (error) {
    console.error("Error fetching progress:", error);
    return NextResponse.json(
      { error: "Failed to fetch progress" },
      { status: 500 }
    );
  }
}
