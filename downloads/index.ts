import { uploadToS3 } from "../storage/index";
import { sanitizeFileName } from "../lib/utils";

interface DownloadResult {
  success: boolean;
  storageKey?: string;
  bytesDownloaded: number;
  error?: string;
}

export async function downloadFile(
  url: string,
  fileName: string,
  jobId: string,
  fileId: string
): Promise<DownloadResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000); // 5 min timeout

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "BulkForge/1.0 (compatible; public-collection-downloader)",
        Accept: "*/*",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      return {
        success: false,
        bytesDownloaded: 0,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const contentLength = parseInt(response.headers.get("content-length") || "0");

    if (!response.body) {
      return {
        success: false,
        bytesDownloaded: 0,
        error: "No response body",
      };
    }

    const safeFileName = sanitizeFileName(fileName);
    const storageKey = `jobs/${jobId}/files/${fileId}/${safeFileName}`;

    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    await uploadToS3(storageKey, buffer, contentType);

    return {
      success: true,
      storageKey,
      bytesDownloaded: contentLength || 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download failed";
    return {
      success: false,
      bytesDownloaded: 0,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
