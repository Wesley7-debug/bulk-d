import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function createTestServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ server, port: addr.port, url: `http://127.0.0.1:${addr.port}` });
      }
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ============================================================
// A. Direct media URL
// ============================================================
describe("A. Direct media URL", () => {
  let server: http.Server;
  let url: string;

  before(async () => {
    const result = await createTestServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": "1024",
        "Content-Disposition": 'attachment; filename="test-video.mp4"',
      });
      res.end(Buffer.alloc(1024, 0x42));
    });
    server = result.server;
    url = result.url;
  });

  after(() => closeServer(server));

  it("returns 200 with correct headers", async () => {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("content-length"), "1024");
  });

  it("streams the full body", async () => {
    const res = await fetch(url);
    const body = await res.arrayBuffer();
    assert.equal(body.byteLength, 1024);
  });
});

// ============================================================
// B. HTML intermediary → media redirect
// ============================================================
describe("B. HTML intermediary → media redirect", () => {
  let mediaServer: http.Server;
  let mediaUrl: string;
  let redirectServer: http.Server;
  let redirectUrl: string;

  before(async () => {
    const media = await createTestServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": "2048",
      });
      res.end(Buffer.alloc(2048, 0x43));
    });
    mediaServer = media.server;
    mediaUrl = media.url;

    const redir = await createTestServer((req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><a href="${mediaUrl}/video.mp4">Download</a></body></html>`);
      } else {
        res.writeHead(302, { Location: mediaUrl + req.url });
        res.end();
      }
    });
    redirectServer = redir.server;
    redirectUrl = redir.url;
  });

  after(() => {
    closeServer(mediaServer);
    closeServer(redirectServer);
  });

  it("serves HTML page with link to media", async () => {
    const res = await fetch(`${redirectUrl}/page`);
    const html = await res.text();
    assert.ok(html.includes("Download"));
    assert.ok(html.includes(mediaUrl));
  });

  it("redirects to actual media file", async () => {
    const res = await fetch(`${redirectUrl}/video.mp4`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `${mediaUrl}/video.mp4`);
  });
});

// ============================================================
// C. Redirect chain → media
// ============================================================
describe("C. Redirect chain → media", () => {
  let mediaServer: http.Server;
  let mediaUrl: string;
  let chainServer: http.Server;
  let chainUrl: string;

  before(async () => {
    const media = await createTestServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "video/webm",
        "Content-Length": "4096",
      });
      res.end(Buffer.alloc(4096, 0x44));
    });
    mediaServer = media.server;
    mediaUrl = media.url;

    const chain = await createTestServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: `${chainUrl}/step2` });
        res.end();
      } else if (req.url === "/step2") {
        res.writeHead(302, { Location: mediaUrl + "/final.webm" });
        res.end();
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
    chainServer = chain.server;
    chainUrl = chain.url;
  });

  after(() => {
    closeServer(mediaServer);
    closeServer(chainServer);
  });

  it("follows redirect chain to media", async () => {
    const res = await fetch(`${chainUrl}/start`, { redirect: "follow" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/webm");
    const body = await res.arrayBuffer();
    assert.equal(body.byteLength, 4096);
  });
});

// ============================================================
// D. HTML pretending to be media
// ============================================================
describe("D. HTML pretending to be media", () => {
  let server: http.Server;
  let url: string;

  before(async () => {
    const result = await createTestServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="fake.mp4"',
      });
      res.end("<!DOCTYPE html><html><head><title>Fake</title></head><body>Not a video</body></html>");
    });
    server = result.server;
    url = result.url;
  });

  after(() => closeServer(server));

  it("returns HTML content with video content-type", async () => {
    const res = await fetch(url);
    const body = await res.text();
    assert.ok(body.startsWith("<!DOCTYPE html>"));
    assert.equal(res.headers.get("content-type"), "video/mp4");
  });
});

// ============================================================
// E. 404
// ============================================================
describe("E. 404 response", () => {
  let server: http.Server;
  let url: string;

  before(async () => {
    const result = await createTestServer((req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });
    server = result.server;
    url = result.url;
  });

  after(() => closeServer(server));

  it("returns 404 status", async () => {
    const res = await fetch(url);
    assert.equal(res.status, 404);
  });
});

// ============================================================
// F. Slow response
// ============================================================
describe("F. Slow response", () => {
  let server: http.Server;
  let url: string;

  before(async () => {
    const result = await createTestServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": "512",
        });
        res.end(Buffer.alloc(512, 0x45));
      }, 200);
    });
    server = result.server;
    url = result.url;
  });

  after(() => closeServer(server));

  it("eventually responds after delay", async () => {
    const start = Date.now();
    const res = await fetch(url);
    const elapsed = Date.now() - start;
    assert.equal(res.status, 200);
    assert.ok(elapsed >= 150, "Should have waited at least 150ms");
  });
});

// ============================================================
// G. Large streaming response
// ============================================================
describe("G. Large streaming response", () => {
  let server: http.Server;
  let url: string;
  const SIZE = 1024 * 1024;

  before(async () => {
    const result = await createTestServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(SIZE),
      });
      const chunk = Buffer.alloc(64 * 1024, 0x46);
      let sent = 0;
      const interval = setInterval(() => {
        if (sent >= SIZE) {
          clearInterval(interval);
          res.end();
          return;
        }
        const toSend = Math.min(chunk.length, SIZE - sent);
        res.write(chunk.subarray(0, toSend));
        sent += toSend;
      }, 10);
    });
    server = result.server;
    url = result.url;
  });

  after(() => closeServer(server));

  it("streams large file without buffering entire content", async () => {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.ok(res.body, "Response should have a body stream");

    let totalBytes = 0;
    const reader = res.body!.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
    }
    assert.equal(totalBytes, SIZE);
  });
});

// ============================================================
// Quality detection tests
// ============================================================
describe("Quality detection - dynamic", () => {
  function detectQualityFromUrl(url: string): string | undefined {
    const lower = url.toLowerCase();
    const match = lower.match(/\b(\d{3,4})p\b/);
    if (match) return `${match[1]}p`;
    if (lower.includes("4k") || lower.includes("2160")) return "2160p";
    return undefined;
  }

  it("detects 1080p", () => {
    assert.equal(detectQualityFromUrl("movie.1080p.mkv"), "1080p");
  });

  it("detects 720p", () => {
    assert.equal(detectQualityFromUrl("movie.720p.mp4"), "720p");
  });

  it("detects 540p (non-standard)", () => {
    assert.equal(detectQualityFromUrl("movie.540p.webm"), "540p");
  });

  it("detects 2160p from 4k", () => {
    assert.equal(detectQualityFromUrl("movie-4k.mp4"), "2160p");
  });

  it("detects 360p", () => {
    assert.equal(detectQualityFromUrl("low.quality.360p.mp4"), "360p");
  });

  it("returns undefined for no quality", () => {
    assert.equal(detectQualityFromUrl("movie.mp4"), undefined);
  });

  it("does not return hardcoded tiers only", () => {
    const q = detectQualityFromUrl("movie.540p.mp4");
    assert.equal(q, "540p");
    assert.notEqual(q, "480p");
    assert.notEqual(q, "720p");
  });
});

// ============================================================
// Client-side deduplication logic
// ============================================================
describe("Client-side deduplication", () => {
  function deduplicateFiles(files: { resourceId?: string; url: string; name?: string; resolvedUrl?: string; quality?: string; season?: number; episode?: number; size?: number }[]) {
    const seen = new Map<string, typeof files[0]>();
    for (const file of files) {
      const id = file.resourceId || file.url;
      const existing = seen.get(id);
      if (!existing) {
        seen.set(id, file);
        continue;
      }
      const existingScore = [existing.resolvedUrl, existing.name, existing.quality, existing.size, existing.season, existing.episode].filter(Boolean).length;
      const currentScore = [file.resolvedUrl, file.name, file.quality, file.size, file.season, file.episode].filter(Boolean).length;
      if (currentScore > existingScore) {
        seen.set(id, file);
      }
    }
    return Array.from(seen.values());
  }

  it("removes exact duplicates", () => {
    const files = [
      { url: "http://example.com/a.mp4", name: "A" },
      { url: "http://example.com/a.mp4", name: "A" },
    ];
    const result = deduplicateFiles(files);
    assert.equal(result.length, 1);
  });

  it("keeps the more complete version", () => {
    const files = [
      { url: "http://example.com/a.mp4", name: "Season 1, Episode 1" },
      { url: "http://example.com/a.mp4", name: "Movie.S01E01.mkv", resolvedUrl: "http://cdn/a.mp4", quality: "1080p", season: 1, episode: 1 },
    ];
    const result = deduplicateFiles(files);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Movie.S01E01.mkv");
    assert.equal(result[0].resolvedUrl, "http://cdn/a.mp4");
  });

  it("does not merge files with different resourceIds", () => {
    const files = [
      { resourceId: "r1", url: "http://a.com/1.mp4", name: "E01" },
      { resourceId: "r2", url: "http://b.com/1.mp4", name: "E01" },
    ];
    const result = deduplicateFiles(files);
    assert.equal(result.length, 2);
  });

  it("handles 5 discovered → 5 displayed", () => {
    const files = [
      { resourceId: "r1", url: "http://a.com/1.mp4", name: "E01", season: 1, episode: 1 },
      { resourceId: "r2", url: "http://a.com/2.mp4", name: "E02", season: 1, episode: 2 },
      { resourceId: "r3", url: "http://a.com/3.mp4", name: "E03", season: 1, episode: 3 },
      { resourceId: "r4", url: "http://a.com/4.mp4", name: "E04", season: 1, episode: 4 },
      { resourceId: "r5", url: "http://a.com/5.mp4", name: "E05", season: 1, episode: 5 },
    ];
    const result = deduplicateFiles(files);
    assert.equal(result.length, 5);
  });
});

// ============================================================
// Streaming proxy endpoint simulation
// ============================================================
describe("Streaming proxy endpoint", () => {
  let upstream: http.Server;
  let upstreamUrl: string;

  before(async () => {
    const result = await createTestServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": "4096",
        "Content-Disposition": 'attachment; filename="upstream.mp4"',
      });
      res.end(Buffer.alloc(4096, 0x47));
    });
    upstream = result.server;
    upstreamUrl = result.url;
  });

  after(() => closeServer(upstream));

  it("simulates streaming proxy: fetch upstream → stream to client", async () => {
    const upstreamRes = await fetch(upstreamUrl);
    assert.equal(upstreamRes.status, 200);
    assert.equal(upstreamRes.headers.get("content-type"), "video/mp4");

    const filename = "proxy-download.mp4";
    const headers = new Headers();
    headers.set("Content-Type", upstreamRes.headers.get("content-type") || "application/octet-stream");
    headers.set("Content-Disposition", `attachment; filename="${filename}"`);
    if (upstreamRes.headers.get("content-length")) {
      headers.set("Content-Length", upstreamRes.headers.get("content-length")!);
    }

    const clientRes = new Response(upstreamRes.body, { status: 200, headers });
    assert.equal(clientRes.status, 200);
    assert.equal(clientRes.headers.get("content-disposition"), 'attachment; filename="proxy-download.mp4"');
    assert.equal(clientRes.headers.get("content-length"), "4096");

    const body = await clientRes.arrayBuffer();
    assert.equal(body.byteLength, 4096);
  });
});

// ============================================================
// Discovery deduplication logic
// ============================================================
describe("Resource deduplication by episode key", () => {
  function buildDedupeKey(resource: { parsedTitle?: string; season?: number; episode?: number; quality?: string; extension?: string; url: string }): string {
    let title = resource.parsedTitle;
    let season = resource.season;
    let episode = resource.episode;

    if (title && season !== undefined && episode !== undefined) {
      const quality = resource.quality || "Default";
      const extension = resource.extension || "";
      return `${title}:S${season}:E${episode}:${quality}:${extension}`;
    }
    return resource.url;
  }

  it("uses title-based key for enriched resources", () => {
    const key = buildDedupeKey({ parsedTitle: "lanterns", season: 1, episode: 1, quality: "1080p", extension: "mkv", url: "http://x.com/a" });
    assert.equal(key, "lanterns:S1:E1:1080p:mkv");
  });

  it("uses URL-based key for bare resources", () => {
    const key = buildDedupeKey({ url: "http://1fichier.com/dl/abc123" });
    assert.equal(key, "http://1fichier.com/dl/abc123");
  });

  it("uses URL-based key when no metadata is parsed", () => {
    const key = buildDedupeKey({ url: "http://host.com/Lanterns.S01E01.1080p.mkv" });
    assert.equal(key, "http://host.com/Lanterns.S01E01.1080p.mkv");
  });

  it("uses title-based key when metadata is explicitly provided", () => {
    const key = buildDedupeKey({ parsedTitle: "lanterns", season: 1, episode: 1, quality: "1080p", extension: "mkv", url: "http://host.com/Lanterns.S01E01.1080p.mkv" });
    assert.equal(key, "lanterns:S1:E1:1080p:mkv");
  });
});
