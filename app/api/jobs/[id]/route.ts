import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../auth";
import { connectToDatabase } from "../../../../lib/mongodb";
import { Job } from "../../../../db/models/Job";
import { JobFile } from "../../../../db/models/JobFile";
import { cancelJobJobs } from "../../../../queue/index";

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
    const job = await Job.findOne({ jobId: id, userId: session.user.id }).lean();
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const files = await JobFile.find({ jobId: id })
      .sort({ createdAt: 1 })
      .lean();

    return NextResponse.json({ job, files });
  } catch (error) {
    console.error("Error fetching job:", error);
    return NextResponse.json(
      { error: "Failed to fetch job" },
      { status: 500 }
    );
  }
}

export async function PATCH(
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
    const body = await request.json();
    const { action } = body;

    const job = await Job.findOne({ jobId: id, userId: session.user.id });
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (action === "cancel") {
      if (["completed", "cancelled"].includes(job.status)) {
        return NextResponse.json(
          { error: "Cannot cancel a completed or already cancelled job" },
          { status: 400 }
        );
      }

      await cancelJobJobs(id);
      await Job.findOneAndUpdate({ jobId: id }, { status: "cancelled" });

      return NextResponse.json({ success: true, status: "cancelled" });
    }

    if (action === "retry") {
      if (!["failed", "partial"].includes(job.status)) {
        return NextResponse.json(
          { error: "Can only retry failed or partial jobs" },
          { status: 400 }
        );
      }

      const failedFiles = await JobFile.find({ jobId: id, failed: true });
      for (const file of failedFiles) {
        const { addDownloadJob } = await import("../../../../queue/index");
        await addDownloadJob({
          jobId: id,
          fileId: file._id.toString(),
          url: file.url,
          fileName: file.fileName,
          quality: job.quality,
          userId: session.user.id,
        });

        await JobFile.findByIdAndUpdate(file._id, {
          failed: false,
          error: undefined,
          retries: 0,
        });
      }

      await Job.findOneAndUpdate(
        { jobId: id },
        { status: "downloading", error: undefined }
      );

      return NextResponse.json({ success: true, retriedFiles: failedFiles.length });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("Error updating job:", error);
    return NextResponse.json(
      { error: "Failed to update job" },
      { status: 500 }
    );
  }
}
