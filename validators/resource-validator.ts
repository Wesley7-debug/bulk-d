import { DiscoveredFile, ErrorState } from "../types";
import { MAX_FILE_SIZE_MB, BLOCKED_MIME_TYPES, BLOCKED_EXTENSIONS, DRM_PATTERNS, KNOWN_FILE_HOSTS, FILE_HOST_EXTENSIONS } from "../lib/constants";
import { mapHttpStatusToErrorState } from "../lib/utils";

interface ValidationResult {
  downloadable: boolean;
  errorState?: ErrorState;
  reason?: string;
  contentType?: string;
  contentLength?: number;
}

class ResourceValidator {
  async validateResource(file: DiscoveredFile): Promise<ValidationResult> {
    if (!this.isValidUrl(file.url)) {
      return { downloadable: false, errorState: "INVALID_URL", reason: "Invalid URL" };
    }

    if (BLOCKED_MIME_TYPES.has(file.mimeType)) {
      return {
        downloadable: false,
        errorState: "NOT_DOWNLOADABLE",
        reason: `Blocked MIME type: ${file.mimeType}`,
      };
    }

    const ext = file.url.split(".").pop()?.split("?")[0]?.toLowerCase() || "";
    if (BLOCKED_EXTENSIONS.has(ext)) {
      return {
        downloadable: false,
        errorState: "NOT_DOWNLOADABLE",
        reason: `Blocked file extension: ${ext}`,
      };
    }

    if (file.size && file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      return {
        downloadable: false,
        errorState: "NOT_DOWNLOADABLE",
        reason: `File too large: ${file.size} bytes`,
      };
    }

    if (this.hasDrmIndicators(file)) {
      return {
        downloadable: false,
        errorState: "NOT_DOWNLOADABLE",
        reason: "DRM-protected content detected",
      };
    }

    if (this.isKnownFileHostWithExtension(file.url)) {
      return { downloadable: true, reason: "Known file host with media extension, HEAD skipped" };
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
        },
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorState = mapHttpStatusToErrorState(response.status);
        return {
          downloadable: false,
          errorState,
          reason: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/html")) {
        return {
          downloadable: false,
          errorState: "NOT_DOWNLOADABLE",
          reason: "URL returns HTML instead of media",
        };
      }

      if (contentType.includes("application/json")) {
        return {
          downloadable: false,
          errorState: "NOT_DOWNLOADABLE",
          reason: "URL returns JSON instead of media",
        };
      }

      const contentLength = parseInt(response.headers.get("content-length") || "0");
      if (contentLength > MAX_FILE_SIZE_MB * 1024 * 1024) {
        return {
          downloadable: false,
          errorState: "NOT_DOWNLOADABLE",
          reason: `File too large: ${contentLength} bytes`,
          contentLength,
        };
      }

      return null;
    } catch (error) {
      const msg = error instanceof Error ? error.message.toLowerCase() : "";
      if (msg.includes("timeout") || msg.includes("aborted")) {
        return {
          downloadable: false,
          errorState: "TIMEOUT",
          reason: "Request timed out",
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
}

export const resourceValidator = new ResourceValidator();
