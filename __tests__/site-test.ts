import { analyzeUrl } from "../crawler/index";

interface TestSite {
  name: string;
  url: string;
  expectedSeason: number;
  expectEpisodes: boolean;
}

const sites: TestSite[] = [
  {
    name: "Waploaded",
    url: "https://shows.waploaded.com/series/731052/ted-season-1",
    expectedSeason: 1,
    expectEpisodes: true,
  },
  {
    name: "NaijaVault",
    url: "https://www.naijavault.com/ted-season-1-complete/",
    expectedSeason: 1,
    expectEpisodes: true,
  },
  {
    name: "9jarocks",
    url: "https://9jarocks.net/videodownload/ted-season-1-complete-id285592.html",
    expectedSeason: 1,
    expectEpisodes: true,
  },
  {
    name: "Nkiri",
    url: "https://thenkiri.com/ted-s01-complete-tv-series/",
    expectedSeason: 1,
    expectEpisodes: true,
  },
  {
    name: "FzTVSeries",
    url: "https://nginx.fzmovies.live/files-Lost--14496.htm",
    expectedSeason: 1,
    expectEpisodes: true,
  },
];

function printResult(site: TestSite, result: any) {
  const episodes = result.files.filter((f: any) => f.downloadable);
  const seasonEps = episodes.filter(
    (f: any) => f.season === site.expectedSeason || f.season === undefined
  );

  console.log(`\n${"=".repeat(70)}`);
  console.log(`SITE: ${site.name}`);
  console.log(`URL: ${site.url}`);
  console.log(`TITLE: ${result.title || "N/A"}`);
  console.log(`STATUS: ${result.status}`);
  console.log(`ACCESS: ${result.accessStatus}`);
  console.log(`SEASON REQUESTED: ${site.expectedSeason}`);
  console.log(`TOTAL FILES: ${result.files.length}`);
  console.log(`DOWNLOADABLE: ${episodes.length}`);
  console.log(`SEASON SCOPED: ${seasonEps.length}`);

  if (seasonEps.length > 0) {
    console.log(`\nEPISODES:`);
    for (const ep of seasonEps.slice(0, 30)) {
      const epNum = ep.episode ? `E${String(ep.episode).padStart(2, "0")}` : "E??";
      const seasonNum = ep.season ? `S${String(ep.season).padStart(2, "0")}` : `S${String(site.expectedSeason).padStart(2, "0")}`;
      const quality = ep.quality ? ` [${ep.quality}]` : "";
      const name = ep.name || ep.url.split("/").pop() || "unknown";
      console.log(`  ${seasonNum}${epNum} ${name.substring(0, 80)}${quality}`);
    }
  } else if (episodes.length > 0) {
    console.log(`\nFILES (no season info):`);
    for (const f of episodes.slice(0, 30)) {
      const name = f.name || f.url.split("/").pop() || "unknown";
      console.log(`  ${name.substring(0, 100)}`);
    }
  } else {
    console.log(`\nNO EPISODES FOUND`);
    if (result.warnings.length > 0) {
      console.log(`WARNINGS:`);
      for (const w of result.warnings) {
        console.log(`  ${w.message}`);
      }
    }
    console.log(`MESSAGE: ${result.message}`);
  }
}

async function main() {
  console.log("BULKFORGE CRAWLER - LIVE SITE TEST (Round 2)");
  console.log("=".repeat(70));

  const results: Array<{ site: TestSite; result: any; ok: boolean }> = [];

  for (const site of sites) {
    console.log(`\n>>> Testing ${site.name}...`);
    try {
      const result = await analyzeUrl(site.url);
      const episodes = result.files.filter((f: any) => f.downloadable);
      const hasEpisodes = episodes.length > 0;
      results.push({ site, result, ok: hasEpisodes });
      printResult(site, result);
    } catch (err) {
      console.log(`>>> FAILED: ${err instanceof Error ? err.message : "unknown"}`);
      results.push({
        site,
        result: { status: "error", files: [], warnings: [], message: String(err), title: null, accessStatus: "UNKNOWN" },
        ok: false,
      });
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("SUMMARY");
  console.log("=".repeat(70));
  let allPassed = true;
  for (const r of results) {
    const status = r.ok ? "PASS" : "FAIL";
    const count = r.result.files.filter((f: any) => f.downloadable).length;
    console.log(`  ${status} ${r.site.name}: ${count} episodes`);
    if (!r.ok) allPassed = false;
  }
  console.log(`\nOVERALL: ${allPassed ? "ALL PASSED" : "SOME FAILED"}`);
}

main().catch(console.error);
