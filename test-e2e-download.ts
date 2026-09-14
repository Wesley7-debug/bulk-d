import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME_MAP: Record<string, string> = {
  ".mkv": "video/x-matroska",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".html": "text/html",
};

const FIXTURES_DIR = path.join(__dirname, "test-fixtures", "small");
const OUTPUT_DIR = path.join(__dirname, "tmp_dl");
const OUTPUT_ZIP = path.join(OUTPUT_DIR, "test-download.zip");

const TEST_FILES = [
  "test_episode_01.mkv",
  "test_episode_02.mkv",
  "test_episode_03.mkv",
];

let fileServer: http.Server;
let fileBaseUrl: string;

function startFileServer(): Promise<void> {
  return new Promise((resolve) => {
    fileServer = http.createServer((req, res) => {
      const reqPath = decodeURIComponent(req.url!.split("?")[0]);
      if (reqPath === "/") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Test file server running");
        return;
      }

      const filePath = path.join(FIXTURES_DIR, reqPath);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_MAP[ext] || "application/octet-stream";
      const stat = fs.statSync(filePath);

      console.log(`[FILESERVER] serving ${reqPath} ct=${contentType} size=${stat.size}`);

      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
        "Content-Disposition": `attachment; filename="${path.basename(filePath)}"`,
      });
      fs.createReadStream(filePath).pipe(res);
    });

    fileServer.listen(0, "127.0.0.1", () => {
      const addr = fileServer.address() as any;
      fileBaseUrl = `http://127.0.0.1:${addr.port}`;
      console.log(`[FILESERVER] started on ${fileBaseUrl}`);
      resolve();
    });
  });
}

function stopFileServer(): Promise<void> {
  return new Promise((resolve) => {
    if (fileServer) fileServer.close(() => resolve());
    else resolve();
  });
}

async function testResolveStatic(): Promise<number> {
  console.log("\n=== TEST 1: resolveStatic on direct file URLs ===");
  const { resolveStatic } = await import("./resolver/index.js");

  let successCount = 0;
  for (const fileName of TEST_FILES) {
    const url = `${fileBaseUrl}/${fileName}`;
    const jobId = `test-static-${fileName}`;
    console.log(`\n[RESOLVE] testing url=${url}`);
    const result = await resolveStatic(url, jobId);
    if (result) {
      console.log(`[RESOLVE] SUCCESS strategy=static url=${result.url} ct=${result.mimeType} filename=${result.filename}`);
      successCount++;
    } else {
      console.log(`[RESOLVE] FAILED url=${url}`);
    }
  }
  console.log(`\n[RESOLVE_STATIC] ${successCount}/${TEST_FILES.length} succeeded`);
  return successCount;
}

async function testFullPipeline(): Promise<{ resolved: number; downloaded: number; zipSize: number }> {
  console.log("\n=== TEST 2: Full resolve -> download -> verify -> ZIP pipeline ===");

  const { resolveStatic } = await import("./resolver/index.js");
  const { ZipArchive } = await import("archiver");
  const { PassThrough, Readable, Transform } = await import("stream");

  const INVALID_DOWNLOAD_CONTENT_TYPES = [
    "text/html", "text/plain", "application/json", "application/xml", "text/xml",
  ];

  const resolved: Array<{
    originalUrl: string;
    resolvedUrl: string;
    filename: string;
    contentType: string;
    contentLength?: number;
    requestHeaders?: Record<string, string>;
  }> = [];

  for (const fileName of TEST_FILES) {
    const url = `${fileBaseUrl}/${fileName}`;
    const jobId = `test-pipeline-${fileName}`;
    const result = await resolveStatic(url, jobId);
    if (result) {
      resolved.push({
        originalUrl: url,
        resolvedUrl: result.url,
        filename: result.filename || fileName.replace(/\.[^.]+$/, ""),
        contentType: result.mimeType,
        contentLength: result.size,
        requestHeaders: result.requestHeaders,
      });
      console.log(`[RESOLVE] resource=${url} status=success strategy=static`);
    } else {
      console.log(`[RESOLVE] resource=${url} status=failed`);
    }
  }

  console.log(`\n[DOWNLOAD] requested=${TEST_FILES.length} selected=${TEST_FILES.length} resolved=${resolved.length}`);

  if (resolved.length === 0) {
    console.error("[DOWNLOAD] No files resolved - cannot proceed");
    return { resolved: 0, downloaded: 0, zipSize: 0 };
  }

  // Download all files to temp files first, then build ZIP from disk
  const downloadedFiles: Array<{ tempPath: string; filename: string }> = [];
  let downloadedCount = 0;

  for (const r of resolved) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const response = await fetch(r.resolvedUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "*/*",
          "Accept-Encoding": "identity",
          ...(r.requestHeaders || {}),
        },
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.error(`[DOWNLOAD] HTTP ${response.status} for ${r.filename}`);
        continue;
      }

      const ct = response.headers.get("content-type") || "application/octet-stream";
      if (INVALID_DOWNLOAD_CONTENT_TYPES.some((t) => ct.toLowerCase().includes(t))) {
        console.error(`[DOWNLOAD] REJECTED content_type=${ct} for ${r.filename}`);
        continue;
      }

      if (!response.body) {
        console.error(`[DOWNLOAD] no body for ${r.filename}`);
        continue;
      }

      // Read first chunk for HTML verification
      const reader = response.body.getReader();
      const firstResult = await reader.read();
      if (firstResult.done || firstResult.value.length === 0) {
        console.error(`[DOWNLOAD] empty response for ${r.filename}`);
        continue;
      }

      const firstChunk = firstResult.value;
      const head = Buffer.from(firstChunk.slice(0, 512)).toString("utf-8").toLowerCase().trim();
      if (
        head.startsWith("<!doctype") || head.startsWith("<html") ||
        head.startsWith("<head") || head.startsWith("<body") ||
        head.startsWith("<script") || head.startsWith("<!--")
      ) {
        console.error(`[DOWNLOAD] REJECTED HTML for ${r.filename} head=${head.substring(0, 60)}`);
        continue;
      }
      console.log(`[DOWNLOAD] first_chunk_verified non_html for ${r.filename}`);

      // Write to temp file
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const tempPath = path.join(OUTPUT_DIR, `dl_${r.filename}`);
      const ws = fs.createWriteStream(tempPath);
      ws.write(Buffer.from(firstChunk));

      let bytes = firstChunk.length;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        ws.write(Buffer.from(value));
      }
      ws.end();
      await new Promise<void>((resolve) => ws.on("finish", resolve));

      console.log(`[DOWNLOAD] status=success file=${r.filename} bytes=${bytes} ct=${ct}`);
      downloadedFiles.push({ tempPath, filename: r.filename });
      downloadedCount++;
    } catch (e: any) {
      console.error(`[DOWNLOAD] failed ${r.filename} error=${e.message}`);
    }
  }

  console.log(`\n[DOWNLOAD] downloaded=${downloadedCount}/${resolved.length} failed=${resolved.length - downloadedCount}`);
  console.log(`[ZIP] inputFiles=${downloadedCount}`);

  // Build ZIP from temp files
  const zipPassThrough = new PassThrough();
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.pipe(zipPassThrough);

  let zipBytes = 0;
  archive.on("data", (chunk: Buffer) => { zipBytes += chunk.length; });
  archive.on("error", (err: Error) => { console.error(`[ZIP] error: ${err.message}`); });

  for (const file of downloadedFiles) {
    const fileStream = fs.createReadStream(file.tempPath);
    archive.append(fileStream, { name: file.filename });
  }

  archive.finalize();

  // Collect ZIP data and write to file
  const chunks: Buffer[] = [];
  for await (const chunk of zipPassThrough) {
    chunks.push(Buffer.from(chunk));
  }
  const zipBuffer = Buffer.concat(chunks);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_ZIP, zipBuffer);

  console.log(`[ZIP] created=test-download.zip size=${zipBuffer.length}`);
  console.log(`[ZIP] verifiedEntries=${downloadedCount}`);
  console.log(`[DOWNLOAD] completed=${downloadedCount}/${TEST_FILES.length}`);

  return { resolved: resolved.length, downloaded: downloadedCount, zipSize: zipBuffer.length };
}

async function testHtmlRejection(): Promise<boolean> {
  console.log("\n=== TEST 3: HTML rejection (Content-Disposition: attachment + HTML body) ===");
  const { resolveStatic } = await import("./resolver/index.js");

  let htmlServer: http.Server;
  const htmlUrl = await new Promise<string>((resolve) => {
    htmlServer = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Disposition": 'attachment; filename="fake-video.zip"',
      });
      res.end("<!DOCTYPE html><html><head><title>Download Page</title></head><body><h1>Click to download</h1></body></html>");
    });
    htmlServer.listen(0, "127.0.0.1", () => {
      const addr = htmlServer!.address() as any;
      resolve(`http://127.0.0.1:${addr.port}/fake-video.zip`);
    });
  });

  const result = await resolveStatic(htmlUrl, "test-html-reject");
  const passed = result === null;
  console.log(passed
    ? "[HTML_REJECT] PASS - correctly rejected HTML disguised as download"
    : "[HTML_REJECT] FAIL - HTML was accepted as valid media!");
  htmlServer!.close();
  return passed;
}

async function test404Rejection(): Promise<boolean> {
  console.log("\n=== TEST 4: HTTP 404 rejection ===");
  const { resolveStatic } = await import("./resolver/index.js");

  let errServer: http.Server;
  const errUrl = await new Promise<string>((resolve) => {
    errServer = http.createServer((req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });
    errServer.listen(0, "127.0.0.1", () => {
      const addr = errServer!.address() as any;
      resolve(`http://127.0.0.1:${addr.port}/missing.mkv`);
    });
  });

  const result = await resolveStatic(errUrl, "test-404-reject");
  const passed = result === null;
  console.log(passed
    ? "[404_REJECT] PASS - correctly rejected 404 response"
    : "[404_REJECT] FAIL - 404 was accepted!");
  errServer!.close();
  return passed;
}

async function verifyZip(zipPath: string): Promise<boolean> {
  console.log("\n=== TEST 5: ZIP verification ===");

  if (!fs.existsSync(zipPath)) {
    console.error(`[ZIP_VERIFY] FAIL - ZIP does not exist: ${zipPath}`);
    return false;
  }

  const stat = fs.statSync(zipPath);
  if (stat.size === 0) {
    console.error("[ZIP_VERIFY] FAIL - ZIP is empty");
    return false;
  }
  console.log(`[ZIP_VERIFY] ZIP exists, size=${stat.size} bytes`);

  const header = Buffer.alloc(4);
  const fd = fs.openSync(zipPath, "r");
  fs.readSync(fd, header, 0, 4, 0);
  fs.closeSync(fd);

  const isZip = header[0] === 0x50 && header[1] === 0x4B && header[2] === 0x03 && header[3] === 0x04;
  if (!isZip) {
    console.error(`[ZIP_VERIFY] FAIL - Invalid ZIP header: ${header.toString("hex")}`);
    return false;
  }
  console.log("[ZIP_VERIFY] ZIP magic bytes valid (PK header)");

  const AdmZip = (await import("adm-zip")).default;
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    console.log(`[ZIP_VERIFY] ZIP contains ${entries.length} entries`);

    if (entries.length !== TEST_FILES.length) {
      console.error(`[ZIP_VERIFY] FAIL - expected ${TEST_FILES.length} entries, got ${entries.length}`);
      return false;
    }

    let allValid = true;
    for (const entry of entries) {
      const entrySize = entry.header.size;
      console.log(`[ZIP_VERIFY]   entry: ${entry.entryName} size=${entrySize}`);

      if (entrySize === 0) {
        console.error(`[ZIP_VERIFY]   FAIL - entry is empty`);
        allValid = false;
        continue;
      }

      const content = entry.getData();
      if (content && content.length > 0) {
        const head = content.slice(0, 512).toString("utf-8").toLowerCase().trim();
        if (head.startsWith("<!doctype") || head.startsWith("<html")) {
          console.error(`[ZIP_VERIFY]   FAIL - entry contains HTML`);
          allValid = false;
        } else {
          const firstHex = content.slice(0, 8).toString("hex");
          console.log(`[ZIP_VERIFY]   PASS - verified non-HTML, magic=${firstHex}`);
        }
      }
    }

    console.log(`[ZIP_VERIFY] ${allValid ? "PASS" : "FAIL"} - ${entries.length} entries verified`);
    return allValid;
  } catch (e: any) {
    console.error(`[ZIP_VERIFY] FAIL - Cannot read ZIP: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log("============================================");
  console.log("BULKFORGE E2E DOWNLOAD PIPELINE TEST");
  console.log("============================================");

  await startFileServer();

  const results: Record<string, any> = {};

  try {
    results.staticResolve = await testResolveStatic();
    results.pipeline = await testFullPipeline();
    results.htmlReject = await testHtmlRejection();
    results.error404Reject = await test404Rejection();
    results.zipVerify = await verifyZip(OUTPUT_ZIP);
  } catch (e: any) {
    console.error("\n[FATAL] Test error:", e.message);
    console.error(e.stack);
  } finally {
    await stopFileServer();
  }

  console.log("\n============================================");
  console.log("TEST RESULTS SUMMARY");
  console.log("============================================");
  console.log(`  Static resolve:    ${results.staticResolve || 0}/${TEST_FILES.length}`);
  console.log(`  Resolved:          ${results.pipeline?.resolved || 0}`);
  console.log(`  Downloaded:        ${results.pipeline?.downloaded || 0}`);
  console.log(`  Failed:            ${(results.pipeline?.resolved || 0) - (results.pipeline?.downloaded || 0)}`);
  console.log(`  ZIP size:          ${results.pipeline?.zipSize || 0} bytes`);
  console.log(`  ZIP entries:       ${results.zipVerify ? TEST_FILES.length : "?"}`);
  console.log(`  ZIP verified:      ${results.zipVerify ? "PASS" : "FAIL"}`);
  console.log(`  HTML rejected:     ${results.htmlReject ? "PASS" : "FAIL"}`);
  console.log(`  404 rejected:      ${results.error404Reject ? "PASS" : "FAIL"}`);

  const allPassed =
    results.staticResolve === TEST_FILES.length &&
    results.pipeline?.resolved === TEST_FILES.length &&
    results.pipeline?.downloaded === TEST_FILES.length &&
    (results.pipeline?.zipSize || 0) > 0 &&
    results.zipVerify &&
    results.htmlReject &&
    results.error404Reject;

  console.log(`\n  OVERALL: ${allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
