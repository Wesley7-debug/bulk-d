import { NextRequest } from "next/server";
import { Readable } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import { sanitizeFileName } from "../../../lib/utils";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CONNECTION_TIMEOUT_MS = 15_000;

interface RequestedFile {
  id: string;
  url: string;
  resolvedUrl: string;
  filename: string;
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const body = await request.json() as { files?: RequestedFile[] };
    const files = Array.isArray(body.files) ? body.files : [];

    if (files.length === 0) {
      return Response.json({ error: "No files provided" }, { status: 400 });
    }

    if (files.length > 1) {
      console.error(`[DOWNLOAD_PROXY] MULTI_FILE_REJECTED count=${files.length}`);
      return Response.json(
        { error: "Use single file mode. For multiple files, trigger individual downloads from the frontend." },
        { status: 400 }
      );
    }

    const file = files[0];

    if (!file.resolvedUrl || typeof file.resolvedUrl !== "string") {
      return Response.json({ error: "Each file must have a resolvedUrl" }, { status: 400 });
    }

    if (file.url && file.resolvedUrl === file.url) {
      console.warn(`[DOWNLOAD_PROXY] RESOLVED_URL_SAME_AS_ORIGINAL id=${file.id} url=${file.url}`);
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(file.resolvedUrl);
    } catch {
      return Response.json({ error: `Invalid resolvedUrl: ${file.resolvedUrl}` }, { status: 400 });
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return Response.json({ error: "Only http/https URLs are supported" }, { status: 400 });
    }

    const filename = sanitizeFileName(file.filename || "download");
    const fileId = file.id || "unknown";

    console.log(`[DOWNLOAD_PROXY] id=${fileId} url=${file.resolvedUrl.substring(0, 120)} filename=${filename}`);

    const connectCtrl = new AbortController();
    const connectTimer = setTimeout(() => {
      console.error(`[DOWNLOAD_PROXY] TIMEOUT connection_after=${CONNECTION_TIMEOUT_MS}ms id=${fileId}`);
      connectCtrl.abort();
    }, CONNECTION_TIMEOUT_MS);

    let upstream: Response;
    try {
      upstream = await fetch(file.resolvedUrl, {
        signal: connectCtrl.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "*/*",
          "Accept-Encoding": "identity",
        },
        redirect: "follow",
      });
    } catch (err: unknown) {
      clearTimeout(connectTimer);
      const name = err instanceof Error ? err.name : "unknown";
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(`[DOWNLOAD_PROXY] FETCH_ERROR id=${fileId} name=${name} msg=${msg}`);
      if (name === "AbortError") {
        return Response.json({ error: "Connection timed out" }, { status: 504 });
      }
      return Response.json({ error: `Failed to fetch upstream: ${msg}` }, { status: 502 });
    }

    clearTimeout(connectTimer);

    if (!upstream.ok) {
      console.error(`[DOWNLOAD_PROXY] UPSTREAM_ERROR id=${fileId} status=${upstream.status}`);
      return Response.json(
        { error: `Upstream returned HTTP ${upstream.status}` },
        { status: 502 }
      );
    }

    if (!upstream.body) {
      console.error(`[DOWNLOAD_PROXY] NO_BODY id=${fileId}`);
      return Response.json({ error: "Upstream response has no body" }, { status: 502 });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const contentLength = upstream.headers.get("content-length");

    const responseHeaders = new Headers();
    responseHeaders.set("Content-Type", contentType);
    responseHeaders.set("Content-Disposition", `attachment; filename="${filename}"`);
    responseHeaders.set("X-BulkForge-File-Id", fileId);
    responseHeaders.set("X-BulkForge-Time-Ms", String(Date.now() - startTime));

    if (contentLength) {
      responseHeaders.set("Content-Length", contentLength);
    }

    const nodeStream = Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    console.log(`[DOWNLOAD_PROXY] STREAMING id=${fileId} ct=${contentType} cl=${contentLength} filename=${filename} ttfb=${Date.now() - startTime}ms`);

    return new Response(webStream, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download proxy failed";
    console.error(`[DOWNLOAD_PROXY] endpoint_error: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}
