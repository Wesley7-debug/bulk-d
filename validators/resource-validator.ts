import { DiscoveredFile, ErrorState, Quality } from "../types";
import { MAX_FILE_SIZE_MB, BLOCKED_MIME_TYPES, BLOCKED_EXTENSIONS, DRM_PATTERNS, KNOWN_FILE_HOSTS, FILE_HOST_EXTENSIONS, EMBED_DOMAINS } from "../lib/constants";
import { mapHttpStatusToErrorState, extractFilenameFromContentDisposition } from "../lib/utils";
import { isEmbedUrl } from "../resolver/index";

interface ValidationResult {
  downloadable: boolean;
  errorState?: ErrorState;
  reason?: string;
  contentType?: string;
  contentLength?: number;
  filename?: string;
  quality?: Quality;
}

class ResourceValidator {
  async validateResource(file: DiscoveredFile): Promise<ValidationResult> {
    if (!this.isValidUrl(file.url)) {
      return { downloadable: false, errorState: "INVALID_URL", reason: "Invalid URL format" };
    }

    if (BLOCKED_MIME_TYPES.has(file.mimeType)) {
      return {
        downloadable: false,
        errorState: "NOT_DOWNLOADABLE",
        reason: `Blocked content type: ${file.mimeType}`,
      };
    }

    const ext = this.extractExtension(file.url);
    if (ext && BLOCKED_EXTENSIONS.has(ext)) {
      return {
        downloadable: false,
        errorState: "NOT_DOWNLOADABLE",
        reason: `Blocked file type: .${ext}`,
      };
    }

    if (file.size && file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      return {
        downloadable: false,
        errorState: "NOT_DOWNLOADABLE",
        reason: `File exceeds size limit: ${(file.size / (1024 * 1024)).toFixed(1)} MB`,
      };
    }

    if (this.hasDrmIndicators(file)) {
      return {
        downloadable: false,
        errorState: "NOT_DOWNLOADABLE",
        reason: "DRM-protected content detected",
      };
    }

    if (isEmbedUrl(file.url)) {
      return {
        downloadable: false,
        errorState: "NOT_DOWNLOADABLE",
        reason: "Embed/trailer URL — not a downloadable file",
      };
    }

    if (this.isKnownFileHostWithExtension(file.url)) {
      return { downloadable: true, reason: "Known file host, HEAD skipped" };
    }

    const headResult = await this.headRequest(file.url);
    if (headResult) {
      return headResult;
    }

    return { downloadable: true };
  }

  async validateResourceBatch(
    files: DiscoveredFile[]
  ): Promise<Map<string, ValidationResult>> {
    const results = new Map<string, ValidationResult>();
    const BATCH_SIZE = 10;

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((file) => this.validateResource(file))
      );
      batch.forEach((file, idx) => {
        results.set(file.url, batchResults[idx]);
      });
    }

    return results;
  }

  private async headRequest(url: string): Promise<ValidationResult | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "*/*",
        },
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorState = mapHttpStatusToErrorState(response.status);
        const reason = this.getHumanReadableError(response.status, response.statusText);
        return {
          downloadable: false,
          errorState,
          reason,
        };
      }

      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("text/html")) {
        return {
          downloadable: false,
          errorState: "NOT_DOWNLOADABLE",
          reason: "URL serves an HTML page instead of a downloadable file",
        };
      }

      if (contentType.includes("application/json")) {
        return {
          downloadable: false,
          errorState: "NOT_DOWNLOADABLE",
          reason: "URL serves JSON data instead of a downloadable file",
        };
      }

      const contentLength = parseInt(response.headers.get("content-length") || "0");
      if (contentLength > MAX_FILE_SIZE_MB * 1024 * 1024) {
        return {
          downloadable: false,
          errorState: "NOT_DOWNLOADABLE",
          reason: `File too large: ${(contentLength / (1024 * 1024)).toFixed(1)} MB`,
          contentLength,
        };
      }

      const contentDisposition = response.headers.get("content-disposition");
      const filename = extractFilenameFromContentDisposition(contentDisposition);

      return null;
    } catch (error) {
      const msg = error instanceof Error ? error.message.toLowerCase() : "";
      if (msg.includes("timeout") || msg.includes("aborted")) {
        return {
          downloadable: false,
          errorState: "TIMEOUT",
          reason: "Request timed out during validation",
        };
      }
      if (msg.includes("enotfound") || msg.includes("econnrefused")) {
        return {
          downloadable: false,
          errorState: "SERVER_ERROR",
          reason: "Could not connect to server",
        };
      }
      return null;
    }
  }

  private getHumanReadableError(status: number, statusText: string): string {
    switch (status) {
      case 401:
        return "Authentication required to access this resource";
      case 403:
        return "Access denied by the server";
      case 404:
        return "Resource not found on the server";
      case 429:
        return "Server is rate limiting requests";
      default:
        if (status >= 500) {
          return "Server error preventing download";
        }
        return `HTTP ${status}: ${statusText}`;
    }
  }

  private isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return ["http:", "https:"].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  private hasDrmIndicators(file: DiscoveredFile): boolean {
    const url = file.url.toLowerCase();
    return DRM_PATTERNS.some((pattern) => pattern.test(url));
  }

  private isKnownFileHostWithExtension(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      const ext = parsed.pathname.split(".").pop()?.split("?")[0]?.toLowerCase() || "";
      const isKnownHost = KNOWN_FILE_HOSTS.some((host) => hostname.includes(host));
      const hasMediaExt = FILE_HOST_EXTENSIONS.has(ext);
      return isKnownHost && hasMediaExt;
    } catch {
      return false;
    }
  }

  private extractExtension(url: string): string | null {
    try {
      const pathname = new URL(url).pathname;
      const ext = pathname.split(".").pop()?.split("?")[0]?.toLowerCase();
      return ext && ext !== pathname ? ext : null;
    } catch {
      return null;
    }
  }
}

export const resourceValidator = new ResourceValidator();
