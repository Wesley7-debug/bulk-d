import { CollectionResult, SourceAdapter } from "../types";

export abstract class BaseAdapter implements SourceAdapter {
  abstract name: string;

  abstract canHandle(url: string): boolean;
  abstract analyze(url: string): Promise<CollectionResult>;

  protected async fetchPage(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "BulkForge/1.0 (compatible; public-collection-downloader)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        throw new Error(`Non-HTML content type: ${contentType}`);
      }

      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  protected async checkResourceAccessible(url: string): Promise<{
    accessible: boolean;
    contentType?: string;
    contentLength?: number;
    statusCode: number;
  }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
        headers: {
          "User-Agent": "BulkForge/1.0 (compatible; public-collection-downloader)",
        },
        redirect: "follow",
      });

      return {
        accessible: response.ok,
        contentType: response.headers.get("content-type") || undefined,
        contentLength: parseInt(response.headers.get("content-length") || "0") || undefined,
        statusCode: response.status,
      };
    } catch {
      return { accessible: false, statusCode: 0 };
    } finally {
      clearTimeout(timeout);
    }
  }
}
