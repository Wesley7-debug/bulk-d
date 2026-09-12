import { Queue } from "bullmq";
import { getRedisClient } from "../lib/redis";
import { DownloadTaskData } from "../types";

let downloadQueue: Queue | null = null;

export function getDownloadQueue(): Queue {
  if (!downloadQueue) {
    downloadQueue = new Queue("downloads", {
      connection: getRedisClient(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 2000,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    });
  }
  return downloadQueue;
}

export async function addDownloadJob(data: DownloadTaskData): Promise<void> {
  const queue = getDownloadQueue();
  await queue.add("download-file", data, {
    jobId: `download-${data.jobId}-${data.fileId}`,
  });
}

export async function addZipJob(jobId: string, userId: string): Promise<void> {
  const queue = getDownloadQueue();
  await queue.add("create-zip", { jobId, userId }, {
    jobId: `zip-${jobId}`,
  });
}

export async function cancelJobJobs(jobId: string): Promise<void> {
  const queue = getDownloadQueue();
  const jobs = await queue.getJobs(["waiting", "active", "delayed"]);
  for (const job of jobs) {
    if (job.data.jobId === jobId) {
      await job.remove();
    }
  }
}
