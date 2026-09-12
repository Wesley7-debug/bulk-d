import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import { connectToDatabase } from "../../../../../lib/mongodb";
import { Job } from "../../../../../db/models/Job";
import { getPresignedDownloadUrl } from "../../../../../storage/index";

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

    if (job.status !== "completed" || !job.zipKey) {
      return NextResponse.json(
        { error: "ZIP not ready" },
        { status: 400 }
      );
    }

    if (job.zipExpiresAt && new Date(job.zipExpiresAt) < new Date()) {
      return NextResponse.json(
        { error: "ZIP has expired" },
        { status: 410 }
      );
    }

    const url = await getPresignedDownloadUrl(job.zipKey, 3600);

    return NextResponse.json({ url, expiresIn: 3600 });
  } catch (error) {
    console.error("Error generating download URL:", error);
    return NextResponse.json(
      { error: "Failed to generate download URL" },
      { status: 500 }
    );
  }
}
