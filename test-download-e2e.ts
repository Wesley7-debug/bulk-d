const TEST_FILES = [
  {
    url: "https://filesamples.com/samples/video/mp4/sample_1280x720_surfing_with_audio.mp4",
    filename: "sample_1280x720.mp4",
  },
  {
    url: "https://sample-videos.com/video321/mp4/720/big_buck_bunny_720p_1mb.mp4",
    filename: "big_buck_bunny_720p.mp4",
  },
  {
    url: "https://www.w3schools.com/html/mov_bbb.mp4",
    filename: "mov_bbb.mp4",
  },
];

const FAIL_FILE = {
  url: "https://httpbin.org/status/404",
  filename: "should_fail.mp4",
};

async function testSingleDownload() {
  console.log("\n=== TEST 1: Single file direct download ===");
  const file = TEST_FILES[0];
  const start = Date.now();

  try {
    const res = await fetch("http://localhost:3000/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceIds: [file.url],
        files: [{ url: file.url, filename: file.filename }],
      }),
    });

    const elapsed = Date.now() - start;
    const ct = res.headers.get("content-type");
    const cd = res.headers.get("content-disposition");
    const cl = res.headers.get("content-length");

    console.log(`Status: ${res.status}`);
    console.log(`Content-Type: ${ct}`);
    console.log(`Content-Disposition: ${cd}`);
    console.log(`Content-Length: ${cl}`);
    console.log(`Time: ${elapsed}ms`);

    if (!res.ok) {
      const body = await res.text();
      console.log(`Error body: ${body}`);
      return false;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`Bytes received: ${buf.length}`);

    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    console.log(`Is ZIP: ${isZip}`);

    if (isZip) {
      console.log("FAIL: Single file should NOT be wrapped in ZIP");
      return false;
    }

    if (buf.length < 1000) {
      console.log("FAIL: File too small, likely not a real download");
      return false;
    }

    console.log("PASS: Single file downloaded directly (not ZIP)");
    return true;
  } catch (e: any) {
    console.log(`ERROR: ${e.message}`);
    return false;
  }
}

async function testMultiFileZip() {
  console.log("\n=== TEST 2: Multi-file ZIP download ===");
  const start = Date.now();

  try {
    const res = await fetch("http://localhost:3000/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceIds: TEST_FILES.map((f) => f.url),
        files: TEST_FILES.map((f) => ({ url: f.url, filename: f.filename })),
      }),
    });

    const elapsed = Date.now() - start;
    const ct = res.headers.get("content-type");
    const cd = res.headers.get("content-disposition");
    const filesHeader = res.headers.get("x-bulkforge-files");
    const failedHeader = res.headers.get("x-bulkforge-failed");

    console.log(`Status: ${res.status}`);
    console.log(`Content-Type: ${ct}`);
    console.log(`Content-Disposition: ${cd}`);
    console.log(`X-BulkForge-Files: ${filesHeader}`);
    console.log(`X-BulkForge-Failed: ${failedHeader}`);
    console.log(`Time: ${elapsed}ms`);

    if (!res.ok) {
      const body = await res.text();
      console.log(`Error body: ${body}`);
      return false;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`Total bytes: ${buf.length}`);

    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    console.log(`Is ZIP: ${isZip}`);

    if (!isZip) {
      console.log("FAIL: Multi-file response should be a ZIP");
      return false;
    }

    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    console.log(`ZIP entries: ${entries.length}`);

    for (const entry of entries) {
      const data = entry.getData();
      const isHtml = data.length > 0 &&
        data.slice(0, 20).toString("utf-8").toLowerCase().includes("<!doctype") ||
        data.slice(0, 20).toString("utf-8").toLowerCase().includes("<html");
      console.log(`  ${entry.entryName}: ${data.length} bytes${isHtml ? " [HTML!]" : ""}`);
      if (isHtml) {
        console.log("FAIL: ZIP contains HTML file instead of media");
        return false;
      }
    }

    console.log("PASS: Multi-file ZIP contains real media files");
    return true;
  } catch (e: any) {
    console.log(`ERROR: ${e.message}`);
    return false;
  }
}

async function testFailureCase() {
  console.log("\n=== TEST 3: Intentional failure (404 URL) ===");
  const start = Date.now();

  try {
    const res = await fetch("http://localhost:3000/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceIds: [FAIL_FILE.url],
        files: [{ url: FAIL_FILE.url, filename: FAIL_FILE.filename }],
      }),
    });

    const elapsed = Date.now() - start;
    console.log(`Status: ${res.status}`);
    console.log(`Time: ${elapsed}ms`);

    if (res.ok) {
      console.log("FAIL: Should have returned an error for 404 URL");
      return false;
    }

    if (elapsed > 30000) {
      console.log("FAIL: Took too long (>30s) for a failure case");
      return false;
    }

    const body = await res.json();
    console.log(`Error: ${body.error}`);

    console.log("PASS: Failed quickly with useful error");
    return true;
  } catch (e: any) {
    console.log(`ERROR: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log("BulkForge E2E Download Test");
  console.log("============================");

  const results = [];

  results.push({ name: "Single file direct download", pass: await testSingleDownload() });
  results.push({ name: "Multi-file ZIP download", pass: await testMultiFileZip() });
  results.push({ name: "Intentional failure (quick)", pass: await testFailureCase() });

  console.log("\n=== SUMMARY ===");
  let allPass = true;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}: ${r.name}`);
    if (!r.pass) allPass = false;
  }
  console.log(`\nOverall: ${allPass ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}`);
  process.exit(allPass ? 0 : 1);
}

main();
