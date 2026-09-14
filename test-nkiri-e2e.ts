import { resolveStatic, resolveHostLink } from "./resolver/index.js";
import { execSync } from "child_process";
import { existsSync } from "fs";

const ffprobePath = (() => {
  try { execSync("ffprobe -version", { stdio: "ignore" }); return "ffprobe"; } catch {
    const mp = execSync('[System.Environment]::GetEnvironmentVariable("Path","Machine")', { shell: "powershell", stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
    const up = execSync('[System.Environment]::GetEnvironmentVariable("Path","User")', { shell: "powershell", stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
    for (const p of (mp + ";" + up).split(";")) { if (existsSync(p + "/ffprobe.exe")) return p + "/ffprobe.exe"; }
    return null;
  }
})();

function runFfprobe(filePath: string): string {
  if (!ffprobePath) return "ffprobe not available";
  try { return execSync(`"${ffprobePath}" -v error -show_format -show_streams "${filePath}"`, { timeout: 30000 }).toString(); }
  catch { return "ffprobe error"; }
}

interface TestCase {
  label: string;
  url: string;
  jobId: string;
}

const testCases: TestCase[] = [
  {
    label: "Nkiri S01E01 via wideshares.org",
    url: "https://wideshares.org/download/cf0ec0a286cc",
    jobId: "nkiri-e2e-001",
  },
  {
    label: "Nkiri S01E06 via downloadwella.com",
    url: "https://downloadwella.com/r5zqf78kicgb/Daemons.of.The.Shadow.Realm.S01E06.(THENKIRI.COM).mkv.html",
    jobId: "nkiri-e2e-006",
  },
];

async function testCase(tc: TestCase) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`=== ${tc.label} ===`);
  console.log(`URL: ${tc.url}`);
  console.log(`Job: ${tc.jobId}`);
  console.log(`${"=".repeat(70)}`);

  // Step 1: Try static resolution
  console.log("\n--- Step 1: resolveStatic() ---");
  const staticResult = await resolveStatic(tc.url, tc.jobId);
  if (staticResult) {
    console.log(`STATIC OK: url=${staticResult.url.substring(0, 150)}`);
    console.log(`  ct=${staticResult.mimeType} size=${staticResult.size} strategy=${staticResult.resolutionStrategy}`);
    console.log(`  log: ${staticResult.resolutionLog.join(" | ").substring(0, 300)}`);
  } else {
    console.log("STATIC: null (no media found via HEAD/GET)");
  }

  // Step 2: If static failed, try full resolution (static → headless)
  if (!staticResult) {
    console.log("\n--- Step 2: resolveHostLink() (static + headless) ---");
    const hostLink = {
      landingUrl: tc.url,
      filename: null as string | null,
      fileSize: null as string | null,
      confidence: 0.5,
      sourcePage: tc.url,
    };
    const headlessResult = await resolveHostLink(hostLink, tc.jobId);
    if (headlessResult.success) {
      console.log(`HEADLESS OK: url=${headlessResult.finalUrl.substring(0, 200)}`);
      console.log(`  ct=${headlessResult.contentType} size=${headlessResult.contentLength} strategy=${headlessResult.resolutionStrategy}`);
      console.log(`  filename=${headlessResult.filename}`);
      console.log(`  log:`);
      for (const entry of headlessResult.resolutionLog) {
        console.log(`    ${entry.substring(0, 200)}`);
      }

      // Verify the resolved URL is actually downloadable
      console.log("\n--- Step 3: Verify resolved URL via HTTP GET ---");
      try {
        const resp = await fetch(headlessResult.finalUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          redirect: "follow",
        });
        const ct = resp.headers.get("content-type") || "";
        const cl = resp.headers.get("content-length") || "0";
        const cd = resp.headers.get("content-disposition") || "";
        console.log(`  HTTP ${resp.status} CT=${ct} CL=${cl} CD=${cd.substring(0, 80)}`);

        const isMedia = ct.includes("video") || ct.includes("audio") || ct.includes("octet")
          || /attachment/i.test(cd);

        if (isMedia && resp.ok) {
          const body = Buffer.from(await resp.arrayBuffer());
          const f16 = body.subarray(0, 16).toString("hex");
          console.log(`  Body size: ${body.length} bytes (${(body.length / 1024 / 1024).toFixed(2)} MB)`);
          console.log(`  First 16 hex: ${f16}`);
          console.log(`  MKV magic (1a45dfa3): ${f16.startsWith("1a45dfa3") ? "YES" : "NO"}`);

          // Save and ffprobe
          const savePath = `test-fixtures/nkiri_${tc.jobId}.mkv`;
          const { writeFileSync } = await import("fs");
          writeFileSync(savePath, body);
          console.log(`  Saved: ${savePath}`);

          const ff = runFfprobe(savePath);
          const durationMatch = ff.match(/duration=([\d.]+)/);
          const codecMatch = ff.match(/codec_name=(\w+)/);
          const formatMatch = ff.match(/format_name=(\S+)/);
          console.log(`  ffprobe format: ${formatMatch?.[1] || "N/A"}`);
          console.log(`  ffprobe codec: ${codecMatch?.[1] || "N/A"}`);
          console.log(`  ffprobe duration: ${durationMatch?.[1] || "N/A"}s`);
        } else {
          console.log(`  NOT MEDIA — response is ${ct}`);
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "unknown";
        console.log(`  HTTP error: ${message.substring(0, 200)}`);
      }
    } else {
      console.log(`HEADLESS: resolution failed (${headlessResult.reason})`);
    }
  } else {
    // Static worked — still verify the URL
    console.log("\n--- Step 2: Verify static-resolved URL ---");
    try {
      const resp = await fetch(staticResult.url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        redirect: "follow",
      });
      const ct = resp.headers.get("content-type") || "";
      const cl = resp.headers.get("content-length") || "0";
      const cd = resp.headers.get("content-disposition") || "";
      console.log(`  HTTP ${resp.status} CT=${ct} CL=${cl} CD=${cd.substring(0, 80)}`);

      if (resp.ok && (ct.includes("video") || ct.includes("octet") || /attachment/i.test(cd))) {
        const body = Buffer.from(await resp.arrayBuffer());
        const f16 = body.subarray(0, 16).toString("hex");
        console.log(`  Body size: ${body.length} (${(body.length / 1024 / 1024).toFixed(2)} MB)`);
        console.log(`  First 16 hex: ${f16}`);
        console.log(`  MKV magic: ${f16.startsWith("1a45dfa3") ? "YES" : "NO"}`);

        const savePath = `test-fixtures/nkiri_${tc.jobId}.mkv`;
        const { writeFileSync } = await import("fs");
        writeFileSync(savePath, body);

        const ff = runFfprobe(savePath);
        const durationMatch = ff.match(/duration=([\d.]+)/);
        const codecMatch = ff.match(/codec_name=(\w+)/);
        console.log(`  ffprobe codec: ${codecMatch?.[1] || "N/A"} duration: ${durationMatch?.[1] || "N/A"}s`);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "unknown";
      console.log(`  HTTP error: ${message.substring(0, 200)}`);
    }
  }
}

(async () => {
  for (const tc of testCases) {
    await testCase(tc);
  }
  console.log("\n\n=== ALL TESTS COMPLETE ===");
})();
