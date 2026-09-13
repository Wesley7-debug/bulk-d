import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../auth";
import { connectToDatabase } from "../../../lib/mongodb";
import { Job } from "../../../db/models/Job";
import { JobFile } from "../../../db/models/JobFile";
import { User } from "../../../db/models/User";
import { generateJobId } from "../../../lib/utils";
import { addDownloadJob } from "../../../queue/index";
import { MAX_FILES_PER_JOB, EMBED_DOMAINS } from "../../../lib/constants";
import { isEmbedUrl } from "../../../resolver/index";

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await connectToDatabase();

    const jobs = await Job.find({ userId: session.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return NextResponse.json({ jobs });
  } catch (error) {
    console.error("Error fetching jobs:", error);
    return NextResponse.json(
      { error: "Failed to fetch jobs" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await connectToDatabase();

    const body = await request.json();
    const { sourceUrl, collectionTitle, quality, fileUrls, thumbnailUrl } =
      body;

    if (!sourceUrl || !collectionTitle || !quality || !fileUrls?.length) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (fileUrls.length > MAX_FILES_PER_JOB) {
      return NextResponse.json(
        { error: `Too many files. Maximum is ${MAX_FILES_PER_JOB}` },
        { status: 400 },
      );
    }

    const validFileUrls = fileUrls.filter((fileData: any) => {
      const fileUrl = typeof fileData === "string" ? fileData : fileData.url;
      if (isEmbedUrl(fileUrl)) {
        return false;
      }
      try {
        const hostname = new URL(fileUrl).hostname.toLowerCase();
        if (EMBED_DOMAINS.some((d) => hostname.includes(d))) {
          return false;
        }
      } catch {
        return false;
      }
      return true;
    });

    if (validFileUrls.length === 0) {
      return NextResponse.json(
        { error: "No valid downloadable files selected (embeds/trailers were filtered out)" },
        { status: 400 },
      );
    }

    const jobId = generateJobId();

    const job = await Job.create({
      jobId,
      userId: session.user.id,
      sourceUrl,
      collectionTitle,
      quality,
      thumbnailUrl,
      status: "queued",
      totalFiles: validFileUrls.length,
    });

    const userId = session.user.id!;

    // Create file records
    const fileRecords = await Promise.all(
      validFileUrls.map(async (fileData: any) => {
        const fileUrl = typeof fileData === "string" ? fileData : fileData.url;
        const fileName =
          typeof fileData === "string"
            ? fileUrl.split("/").pop() || "unnamed"
            : fileData.name || fileUrl.split("/").pop() || "unnamed";

        return JobFile.create({
          jobId,
          userId,
          url: fileUrl,
          fileName,
          quality,
          fileType: "video",
          mimeType: "video/mp4",
          selected: true,
        });
      }),
    );

    // Update user job count
    await User.findByIdAndUpdate(userId, {
      $inc: { jobCount: 1 },
    });

    // Queue download jobs
    for (const file of fileRecords) {
      await addDownloadJob({
        jobId,
        fileId: file._id.toString(),
        url: file.url,
        fileName: file.fileName,
        quality,
        userId,
      });
    }

    // Update job status
    await Job.findOneAndUpdate(
      { jobId },
      { status: "downloading", startedAt: new Date() },
    );

    return NextResponse.json({
      success: true,
      jobId,
      totalFiles: fileRecords.length,
    });
  } catch (error) {
    console.error("Error creating job:", error);
    return NextResponse.json(
      { error: "Failed to create job" },
      { status: 500 },
    );
  }
}
