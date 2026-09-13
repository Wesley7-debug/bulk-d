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
  const timeout = setTimeout(() => controller.abort(), 600000); // 10 min timeout for large videos

  try {
    console.log(`[DOWNLOAD] starting fetch url=${url.substring(0, 120)} fileName=${fileName}`);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        Referer: new URL(url).origin + "/",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      console.error(`[DOWNLOAD] HTTP error status=${response.status} statusText=${response.statusText}`);
      return {
        success: false,
        bytesDownloaded: 0,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const contentLength = parseInt(response.headers.get("content-length") || "0");

    if (contentType.includes("text/html")) {
      console.error(`[DOWNLOAD] got HTML instead of media content_type=${contentType}`);
      return {
        success: false,
        bytesDownloaded: 0,
        error: `Server returned HTML page instead of file (content-type: ${contentType})`,
      };
    }

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
    let totalBytes = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.length;
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    await uploadToS3(storageKey, buffer, contentType);

    console.log(`[DOWNLOAD] success fileName=${fileName} bytes=${totalBytes} content_type=${contentType}`);

    return {
      success: true,
      storageKey,
      bytesDownloaded: totalBytes || contentLength || 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download failed";
    console.error(`[DOWNLOAD] failed fileName=${fileName} error=${message}`);
    return {
      success: false,
      bytesDownloaded: 0,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
