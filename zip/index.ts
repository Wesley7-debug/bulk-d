const archiver = require("archiver");
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
    return new Promise((resolve) => {
      const archive = archiver("zip", {
        zlib: { level: 6 },
      });

      const chunks: Buffer[] = [];

      archive.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      archive.on("end", async () => {
        const buffer = Buffer.concat(chunks);
        await uploadToS3(storageKey, buffer, "application/zip");
        resolve({
          success: true,
          storageKey,
          size: buffer.length,
        });
      });

      archive.on("error", (err: Error) => {
        resolve({
          success: false,
          error: err.message,
        });
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
