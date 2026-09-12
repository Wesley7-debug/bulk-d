import { Worker, Job } from "bullmq";
import { getRedisClient } from "../lib/redis";
import { connectToDatabase } from "../lib/mongodb";
import { Job as JobModel } from "../db/models/Job";
import { JobFile } from "../db/models/JobFile";
import { downloadFile } from "../downloads/index";
import { DownloadTaskData } from "../types";

let downloadWorker: Worker | null = null;

export function startDownloadWorker(): Worker {
  if (downloadWorker) return downloadWorker;

  downloadWorker = new Worker(
    "downloads",
    async (job: Job) => {
      await connectToDatabase();

      if (job.name === "download-file") {
        return handleDownloadFile(job);
      } else if (job.name === "create-zip") {
        return handleCreateZip(job);
      }
    },
    {
      connection: getRedisClient(),
      concurrency: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "5"),
    }
  );

  downloadWorker.on("completed", (job) => {
    console.log(`Job ${job.id} completed: ${job.name}`);
  });

  downloadWorker.on("failed", (job, err) => {
    console.error(`Job ${job?.id} failed: ${job?.name}`, err);
  });

  return downloadWorker;
}

async function handleDownloadFile(job: Job): Promise<void> {
  const data = job.data as DownloadTaskData;
  const { jobId, fileId, url, fileName, quality, userId } = data;

  const result = await downloadFile(url, fileName, jobId, fileId);

  if (result.success) {
    await JobFile.findByIdAndUpdate(fileId, {
      downloaded: true,
      storageKey: result.storageKey,
    });

    await JobModel.findOneAndUpdate(
      { jobId },
      {
        $inc: { completedFiles: 1, downloadedBytes: result.bytesDownloaded },
      }
    );
  } else {
    const file = await JobFile.findById(fileId);
    if (file && file.retries < file.maxRetries) {
      await JobFile.findByIdAndUpdate(fileId, {
        $inc: { retries: 1 },
        error: result.error,
      });
      throw new Error(result.error || "Download failed, will retry");
    } else {
      await JobFile.findByIdAndUpdate(fileId, {
        failed: true,
        error: result.error,
      });
      await JobModel.findOneAndUpdate(
        { jobId },
        { $inc: { failedFiles: 1 } }
      );
    }
  }

  // Check if all files are processed
  const jobDoc = await JobModel.findOne({ jobId });
  if (jobDoc) {
    const totalProcessed = jobDoc.completedFiles + jobDoc.failedFiles;
    if (totalProcessed >= jobDoc.totalFiles) {
      if (jobDoc.failedFiles === 0) {
        await JobModel.findOneAndUpdate(
          { jobId },
          { status: "packaging" }
        );
        // Trigger ZIP creation
        const { addZipJob } = await import("../queue/index");
        await addZipJob(jobId, userId);
      } else if (jobDoc.completedFiles > 0) {
        await JobModel.findOneAndUpdate(
          { jobId },
          { status: "partial" }
        );
      } else {
        await JobModel.findOneAndUpdate(
          { jobId },
          { status: "failed", error: "All downloads failed" }
        );
      }
    }
  }
}

async function handleCreateZip(job: Job): Promise<void> {
  const { jobId } = job.data;

  const files = await JobFile.find({
    jobId,
    downloaded: true,
    storageKey: { $exists: true, $ne: null },
  });

  if (files.length === 0) {
    await JobModel.findOneAndUpdate(
      { jobId },
      { status: "failed", error: "No files downloaded successfully" }
    );
    return;
  }

  const { createZipFromStorage } = await import("../zip/index");
  const result = await createZipFromStorage(
    jobId,
    files.map((f) => ({
      storageKey: f.storageKey!,
      fileName: f.fileName,
    }))
  );

  if (result.success) {
    const { getPresignedDownloadUrl } = await import("../storage/index");
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 72);

    await JobModel.findOneAndUpdate(
      { jobId },
      {
        status: "completed",
        zipKey: result.storageKey,
        zipSize: result.size,
        zipExpiresAt: expiresAt,
        completedAt: new Date(),
      }
    );

    try {
      const zipUrl = await getPresignedDownloadUrl(result.storageKey!, 72 * 3600);
      await JobModel.findOneAndUpdate({ jobId }, { zipUrl });
    } catch {
      // URL will be generated on demand
    }
  } else {
    await JobModel.findOneAndUpdate(
      { jobId },
      { status: "failed", error: result.error }
    );
  }
}

export function stopDownloadWorker(): void {
  if (downloadWorker) {
    downloadWorker.close();
    downloadWorker = null;
  }
}
