import { ZipArchive as Archiver } from "archiver";
import { Readable } from "stream";
import { getS3ObjectStream, uploadToS3 } from "../storage/index";

interface ZipResult {
  success: boolean;
  storageKey?: string;
  size?: number;
  error?: string;
}

export async function createZipFromStorage(
  jobId: string,
  files: Array<{ storageKey: string; fileName: string }>
): Promise<ZipResult> {
  const storageKey = `jobs/${jobId}/zip/${jobId}.zip`;

  try {
    const { PassThrough } = await import("stream");
    const zipPassThrough = new PassThrough();

    const uploadPromise = uploadToS3(storageKey, zipPassThrough as any, "application/zip");

    return new Promise((resolve) => {
      const archive = new Archiver({ zlib: { level: 6 } });
      let totalBytes = 0;

      archive.pipe(zipPassThrough);

      archive.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
      });

      archive.on("error", (err: Error) => {
        resolve({ success: false, error: err.message });
      });

      archive.on("end", async () => {
        try {
          await uploadPromise;
          resolve({ success: true, storageKey, size: totalBytes });
        } catch (err) {
          resolve({ success: false, error: err instanceof Error ? err.message : "Upload failed" });
        }
      });

      (async () => {
        for (const file of files) {
          try {
            const stream = await getS3ObjectStream(file.storageKey);
            if (stream) {
              const nodeStream = Readable.fromWeb(stream as any);
              archive.append(nodeStream, { name: file.fileName });
            }
          } catch {
            // Skip files that can't be read
          }
        }
        archive.finalize();
      })();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ZIP creation failed";
    return { success: false, error: message };
  }
}
