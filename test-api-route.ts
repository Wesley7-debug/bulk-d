import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "test-fixtures", "small");
const OUTPUT_DIR = path.join(__dirname, "tmp_dl");

const MIME_MAP: Record<string, string> = {
  ".mkv": "video/x-matroska",
  ".html": "text/html",
};

let fileServer: http.Server;
let fileBaseUrl: string;

function startFileServer(): Promise<void> {
  return new Promise((resolve) => {
    fileServer = http.createServer((req, res) => {
      const reqPath = decodeURIComponent(req.url!.split("?")[0]);
      const filePath = path.join(FIXTURES_DIR, reqPath);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const ct = MIME_MAP[ext] || "application/octet-stream";
      const stat = fs.statSync(filePath);
      console.log(`[FILESERVER] serving ${reqPath} ct=${ct} size=${stat.size}`);
      res.writeHead(200, { "Content-Type": ct, "Content-Length": String(stat.size), "Content-Disposition": `attachment; filename="${path.basename(filePath)}"` });
      fs.createReadStream(filePath).pipe(res);
    });
    fileServer.listen(0, "127.0.0.1", () => {
      fileBaseUrl = `http://127.0.0.1:${(fileServer.address() as any).port}`;
      console.log(`[FILESERVER] started on ${fileBaseUrl}`);
      resolve();
    });
  });
}

function stopFileServer(): Promise<void> {
  return new Promise((resolve) => { if (fileServer) fileServer.close(() => resolve()); else resolve(); });
}

function makeRequest(body: object): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/download",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headers[k] = v;
        }
        resolve({ status: res.statusCode || 0, headers, body: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function testSuccessCase() {
  console.log("\n=== TEST 1: 3 valid files → resolved=3, downloaded=3, ZIP with 3 entries ===");
  const files = ["test_episode_01.mkv", "test_episode_02.mkv", "test_episode_03.mkv"];
  const body = {
    files: files.map(f => ({ url: `${fileBaseUrl}/${f}`, filename: f })),
    resourceIds: files.map(f => `${fileBaseUrl}/${f}`),
  };

  const res = await makeRequest(body);
  console.log(`[API] status=${res.status} selected=${res.headers["x-bulkforge-selected"]} files=${res.headers["x-bulkforge-files"]} failed=${res.headers["x-bulkforge-failed"]} resolutionFailed=${res.headers["x-bulkforge-resolution-failed"]}`);

  if (res.status !== 200) {
    console.error(`[API] FAIL - expected 200, got ${res.status}: ${res.body.toString("utf-8").substring(0, 200)}`);
    return false;
  }

  const selected = parseInt(res.headers["x-bulkforge-selected"] || "0");
  const filesCount = parseInt(res.headers["x-bulkforge-files"] || "0");
  const failed = parseInt(res.headers["x-bulkforge-failed"] || "0");
  const resolutionFailed = parseInt(res.headers["x-bulkforge-resolution-failed"] || "0");

  console.log(`[API] selected=${selected} resolved+downloaded=${filesCount} failed=${failed} resolutionFailed=${resolutionFailed}`);

  if (selected !== 3) { console.error(`[API] FAIL - selected=${selected}, expected 3`); return false; }
  if (filesCount !== 3) { console.error(`[API] FAIL - filesCount=${filesCount}, expected 3`); return false; }
  if (failed !== 0) { console.error(`[API] FAIL - failed=${failed}, expected 0`); return false; }
  if (resolutionFailed !== 0) { console.error(`[API] FAIL - resolutionFailed=${resolutionFailed}, expected 0`); return false; }

  const zipPath = path.join(OUTPUT_DIR, "api-test.zip");
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(zipPath, res.body);

  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  console.log(`[ZIP] entries=${entries.length}`);
  if (entries.length !== 3) { console.error(`[ZIP] FAIL - expected 3 entries, got ${entries.length}`); return false; }

  for (const entry of entries) {
    const content = entry.getData();
    const head = content.slice(0, 20).toString("hex");
    console.log(`[ZIP]   entry=${entry.entryName} size=${entry.header.size} magic=${head}`);
    if (entry.header.size === 0) { console.error(`[ZIP] FAIL - empty entry`); return false; }
    const text = content.slice(0, 512).toString("utf-8").toLowerCase().trim();
    if (text.startsWith("<!doctype") || text.startsWith("<html")) { console.error(`[ZIP] FAIL - entry is HTML`); return false; }
  }

  console.log("[TEST1] PASS");
  return true;
}

async function testMixedCase() {
  console.log("\n=== TEST 2: 2 valid + 1 HTML → resolved=2, downloaded=2, failed=1 ===");
  const body = {
    files: [
      { url: `${fileBaseUrl}/test_episode_01.mkv`, filename: "ep01.mkv" },
      { url: `${fileBaseUrl}/test_episode_02.mkv`, filename: "ep02.mkv" },
      { url: `${fileBaseUrl}/fake_download.html`, filename: "fake.html" },
    ],
    resourceIds: [
      `${fileBaseUrl}/test_episode_01.mkv`,
      `${fileBaseUrl}/test_episode_02.mkv`,
      `${fileBaseUrl}/fake_download.html`,
    ],
  };

  const res = await makeRequest(body);
  console.log(`[API] status=${res.status} selected=${res.headers["x-bulkforge-selected"]} files=${res.headers["x-bulkforge-files"]} failed=${res.headers["x-bulkforge-failed"]} resolutionFailed=${res.headers["x-bulkforge-resolution-failed"]}`);

  const selected = parseInt(res.headers["x-bulkforge-selected"] || "0");
  const filesCount = parseInt(res.headers["x-bulkforge-files"] || "0");
  const resolutionFailed = parseInt(res.headers["x-bulkforge-resolution-failed"] || "0");

  console.log(`[API] selected=${selected} resolved+downloaded=${filesCount} resolutionFailed=${resolutionFailed}`);

  if (selected !== 3) { console.error(`[API] FAIL - selected=${selected}, expected 3`); return false; }
  if (filesCount !== 2) { console.error(`[API] FAIL - filesCount=${filesCount}, expected 2`); return false; }
  if (resolutionFailed !== 1) { console.error(`[API] FAIL - resolutionFailed=${resolutionFailed}, expected 1`); return false; }

  const zipPath = path.join(OUTPUT_DIR, "api-test-mixed.zip");
  fs.writeFileSync(zipPath, res.body);
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  console.log(`[ZIP] entries=${entries.length}`);
  if (entries.length !== 2) { console.error(`[ZIP] FAIL - expected 2 entries, got ${entries.length}`); return false; }

  console.log("[TEST2] PASS");
  return true;
}

async function testAllFail() {
  console.log("\n=== TEST 3: 404 URL → selected=1, resolved=0, error response ===");
  let errServer: http.Server;
  const errUrl = await new Promise<string>((resolve) => {
    errServer = http.createServer((req, res) => {
      res.writeHead(404);
      res.end("Not found");
    });
    errServer.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(errServer!.address() as any).port}/nope.mkv`);
    });
  });

  const body = {
    files: [{ url: errUrl, filename: "nope.mkv" }],
    resourceIds: [errUrl],
  };

  const res = await makeRequest(body);
  console.log(`[API] status=${res.status}`);

  errServer!.close();

  if (res.status === 502) {
    const data = JSON.parse(res.body.toString("utf-8"));
    console.log(`[API] error=${data.error} selected=${data.selected} resolved=${data.resolved} resolutionFailed=${data.resolutionFailed}`);
    if (data.resolved === 0 && data.resolutionFailed === 1) {
      console.log("[TEST3] PASS - all-fail correctly returns 502");
      return true;
    }
  }
  console.error(`[TEST3] FAIL - expected 502 with resolved=0, got ${res.status}`);
  return false;
}

async function testHtmlAttachmentBug() {
  console.log("\n=== TEST 4: HTML with Content-Disposition: attachment (production bug) → resolutionFailed ===");
  let htmlServer: http.Server;
  const htmlUrl = await new Promise<string>((resolve) => {
    htmlServer = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Disposition": 'attachment; filename="The.Returned.S01.540p.x265.AAC.zip"',
      });
      res.end("<!DOCTYPE html><html><head><title>Download The.Returned.S01</title></head><body><h1>Your download is ready</h1><p>Click the button below</p></body></html>");
    });
    htmlServer.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(htmlServer!.address() as any).port}/The.Returned.S01.540p.x265.AAC.zip`);
    });
  });

  const body = {
    files: [{ url: htmlUrl, filename: "The.Returned.S01.zip" }],
    resourceIds: [htmlUrl],
  };

  const res = await makeRequest(body);
  console.log(`[API] status=${res.status}`);

  htmlServer!.close();

  if (res.status === 502) {
    const data = JSON.parse(res.body.toString("utf-8"));
    console.log(`[API] error=${data.error} selected=${data.selected} resolved=${data.resolved} resolutionFailed=${data.resolutionFailed}`);
    if (data.resolved === 0 && data.resolutionFailed === 1) {
      console.log("[TEST4] PASS - HTML-with-attachment correctly rejected, not counted as resolved");
      return true;
    }
  }
  console.error(`[TEST4] FAIL - expected 502 with resolved=0, got ${res.status}`);
  return false;
}

async function main() {
  console.log("============================================");
  console.log("BULKFORGE API ROUTE E2E TEST");
  console.log("============================================");

  await startFileServer();

  const results: boolean[] = [];

  try {
    results.push(await testSuccessCase());
    results.push(await testMixedCase());
    results.push(await testAllFail());
    results.push(await testHtmlAttachmentBug());
  } catch (e: any) {
    console.error("\n[FATAL]", e.message, e.stack);
    results.push(false);
  } finally {
    await stopFileServer();
  }

  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(`\n============================================`);
  console.log(`RESULTS: ${passed}/${total} ${passed === total ? "ALL PASSED" : "SOME FAILED"}`);
  console.log(`============================================`);

  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => { console.error("Unhandled:", e); process.exit(1); });
