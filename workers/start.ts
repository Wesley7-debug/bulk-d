import { startDownloadWorker, stopDownloadWorker } from "./download-worker";
import { connectToDatabase } from "../lib/mongodb";

async function main() {
  console.log("Starting BulkForge worker...");

  await connectToDatabase();
  startDownloadWorker();

  console.log("Worker is running. Press Ctrl+C to stop.");

  process.on("SIGINT", async () => {
    console.log("Shutting down worker...");
    stopDownloadWorker();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("Shutting down worker...");
    stopDownloadWorker();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
