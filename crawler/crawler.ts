import * as cheerio from "cheerio";
import {
  AnalysisResult,
  AnalysisStatus,
  AccessStatus,
  DiscoveredFile,
  AccessDiagnostics,
  AnalysisWarning,
  Quality,
  UserIntent,
  AIPageAnalysis,
  PageContext,
} from "../types";
import { parseUserIntent } from "../lib/intent-parser";
import { rankLinks } from "../lib/relevance-scorer";
import { analyzePageWithAI } from "../lib/ai-analyzer";
import { discovery } from "../discovery/index";
import { extractors } from "../extractors/index";
import { resourceValidator } from "../validators/resource-validator";
import { normalizeUrl, getBaseDomain } from "../lib/utils";
import { USER_AGENT, CRAWL_TIMEOUT_MS } from "../lib/constants";
import { logger, generateJobId } from "../lib/logger";

const MAX_DEPTH = 3;
const MAX_PAGES = 30;
const RELEVANCE_THRESHOLD = 0.35;

interface CrawlCandidate {
  url: string;
  depth: number;
  score: number;
  reason: string;
}

class TargetedCrawler {
  private jobId: string;
  private visited = new Set<string>();
  private skipped = new Map<string, { score: number; reason: string }>();
  private collectedResources: DiscoveredFile[] = [];
  private warnings: AnalysisWarning[] = [];
  private startTime: number;
  private intent: UserIntent;
  private aiAnalysis: AIPageAnalysis | null = null;
  private pagesCrawled = 0;
  private targetFound = false;

  constructor(inputUrl: string, jobId?: string) {
    this.jobId = jobId || generateJobId();
    this.startTime = Date.now();
    this.intent = parseUserIntent(inputUrl);
  }

  private log(stage: string, message: string, data?: Record<string, unknown>): void {
    logger.log(this.jobId, stage, message, data);
  }

  async analyze(inputUrl: string): Promise<AnalysisResult> {
    this.log("INPUT", `url=${inputUrl}`, {
      query: this.intent.query,
      derivedTitle: this.intent.derivedTitle,
      requestedTitle: this.intent.requestedTitle,
      requestedSeason: this.intent.requestedSeason,
    });

    const normalizedEntry = normalizeUrl(inputUrl);
    const domain = getBaseDomain(normalizedEntry);

    this.log("NORMALIZE", `domain=${domain}`);

    const diagnostics = await this.runDiagnostics(normalizedEntry);

    if (diagnostics.accessStatus !== "ACCESSIBLE") {
      const { status, message } = this.mapAccessToAnalysis(diagnostics.accessStatus);
      this.log("RESULT", `status=${status}`, { accessStatus: diagnostics.accessStatus });
      return this.buildResult({
        status,
        accessStatus: diagnostics.accessStatus,
        domain,
        originalUrl: inputUrl,
        finalUrl: diagnostics.finalUrl,
        title: null,
        description: null,
        thumbnail: null,
        crawl: { pagesDiscovered: 0, pagesVisited: 0, pagesBlocked: 0, pagesFailed: 0 },
        files: [],
        statistics: { discovered: 0, downloadable: 0, inaccessible: 0, unsupported: 0, totalSize: 0 },
        availableQualities: [],
        message,
        details: diagnostics,
      });
    }

    this.log("CRAWL", "starting targeted crawl");

    const entryPage = await this.fetchAndParsePage(normalizedEntry, 0);
    if (!entryPage) {
      return this.buildResult({
        status: "BLOCKED",
        accessStatus: "BLOCKED_403",
        domain,
        originalUrl: inputUrl,
        finalUrl: diagnostics.finalUrl,
        title: null,
        description: null,
        thumbnail: null,
        crawl: { pagesDiscovered: 0, pagesVisited: 0, pagesBlocked: 0, pagesFailed: 0 },
        files: [],
        statistics: { discovered: 0, downloadable: 0, inaccessible: 0, unsupported: 0, totalSize: 0 },
        availableQualities: [],
        message: "Could not fetch the entry page.",
        details: diagnostics,
      });
    }

    this.log("EXTRACT", `page_context title="${entryPage.title}" links=${entryPage.links.length}`);

    try {
      this.aiAnalysis = await analyzePageWithAI(entryPage, this.intent);
      if (this.aiAnalysis) {
        this.log("AI", `pageType=${this.aiAnalysis.pageType} confidence=${this.aiAnalysis.confidence}`, {
          targetTitle: this.aiAnalysis.target.title,
          targetSeason: this.aiAnalysis.target.season,
          relevantLinks: this.aiAnalysis.relevantLinks.length,
          irrelevantLinks: this.aiAnalysis.irrelevantLinks.length,
        });
        this.mergeAIAnalysis(this.aiAnalysis);
      } else {
        this.log("AI", "no AI available, using deterministic scoring only");
      }
    } catch (e) {
      this.log("AI", `error: ${e instanceof Error ? e.message : "unknown"}, falling back to deterministic`);
    }

    const candidateLinks = this.buildCandidateList(entryPage, 0);
    this.log("DISCOVERY", `candidates=${candidateLinks.length}`);

    const allResources = [...(await this.extractResourcesFromPage(entryPage))];

    for (const candidate of candidateLinks) {
      if (this.targetFound || this.pagesCrawled >= MAX_PAGES) break;

      const page = await this.fetchAndParsePage(candidate.url, candidate.depth);
      if (!page) continue;

      this.log("CRAWL", `status=200 url=${candidate.url}`);

      const pageResources = await this.extractResourcesFromPage(page);
      allResources.push(...pageResources);

      this.log("EXTRACTION", `url=${candidate.url} candidates=${pageResources.length}`);

      if (pageResources.length > 0) {
        this.targetFound = true;
        this.log("CRAWL", "target collection found, stopping exploration");
      }

      if (candidate.depth + 1 < MAX_DEPTH) {
        const newCandidates = this.buildCandidateList(page, candidate.depth + 1);
        for (const nc of newCandidates) {
          if (!candidateLinks.some((c) => c.url === nc.url)) {
            candidateLinks.push(nc);
          }
        }
      }
    }

    this.log("VALIDATION", `total_candidates=${allResources.length}`);

    const validatedResources = await this.validateResources(allResources);
    const downloadable = validatedResources.filter((f) => f.downloadable);
    const inaccessible = validatedResources.filter((f) => !f.downloadable);
    const totalSize = downloadable.reduce((sum, f) => sum + (f.size || 0), 0);

    this.log("VALIDATION", `downloadable=${downloadable.length} inaccessible=${inaccessible.length}`, {
      downloadableUrls: downloadable.map((f) => f.url).slice(0, 10),
      inaccessibleReasons: inaccessible.map((f) => ({ url: f.url, reason: f.downloadBlocked })).slice(0, 10),
    });

    const title = this.resolveTitle(entryPage, this.aiAnalysis);
    const qualities = this.extractAvailableQualities(downloadable);

    this.log("QUALITY", `available=${qualities.join(",")}`);

    let status: AnalysisStatus;
    let message: string;

    if (downloadable.length > 0) {
      status = "MEDIA_FOUND";
      message = `BulkForge discovered ${allResources.length} candidate resources. ${downloadable.length} are downloadable.`;
    } else if (allResources.length > 0) {
      status = "NO_MEDIA_FOUND";
      message = `Found ${allResources.length} candidates, but none could be verified as downloadable.`;
    } else {
      status = "NO_MEDIA_FOUND";
      message = "No downloadable resources were discovered. The content may be dynamically loaded or protected.";
    }

    this.log("RESULT", `status=${status}`);

    return this.buildResult({
      status,
      accessStatus: "ACCESSIBLE",
      domain,
      originalUrl: inputUrl,
      finalUrl: diagnostics.finalUrl,
      title,
      description: this.aiAnalysis?.description || entryPage.metadata.description || null,
      thumbnail: entryPage.metadata["og:image"] || null,
      crawl: {
        pagesDiscovered: this.visited.size + this.skipped.size,
        pagesVisited: this.visited.size,
        pagesBlocked: 0,
        pagesFailed: 0,
      },
      files: validatedResources,
      statistics: {
        discovered: allResources.length,
        downloadable: downloadable.length,
        inaccessible: inaccessible.length,
        unsupported: 0,
        totalSize,
      },
      availableQualities: qualities,
      message,
      details: diagnostics,
    });
  }

  private mergeAIAnalysis(analysis: AIPageAnalysis): void {
    if (analysis.target.title && !this.intent.requestedTitle) {
      this.intent.requestedTitle = analysis.target.title;
    }
    if (analysis.target.season && !this.intent.requestedSeason) {
      this.intent.requestedSeason = String(analysis.target.season);
    }
  }

  private buildCandidateList(page: PageContext, depth: number): CrawlCandidate[] {
    const candidates: CrawlCandidate[] = [];
    const scored = rankLinks(page.links, this.intent, page);

    for (const s of scored) {
      if (s.decision === "QUEUE" && s.total >= RELEVANCE_THRESHOLD) {
        if (!this.visited.has(s.url)) {
          candidates.push({
            url: s.url,
            depth,
            score: s.total,
            reason: s.reason,
          });
          this.log("DISCOVERY", `url=${s.url} score=${s.total.toFixed(2)} decision=QUEUE reason=${s.reason}`);
        }
      } else {
        if (!this.visited.has(s.url)) {
          this.skipped.set(s.url, { score: s.total, reason: s.reason });
          this.log("DISCOVERY", `url=${s.url} score=${s.total.toFixed(2)} decision=SKIP reason=${s.reason}`);
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, MAX_PAGES - this.visited.size);
  }

  private async extractResourcesFromPage(page: PageContext): Promise<DiscoveredFile[]> {
    try {
      const htmlToParse = page.rawHtml || page.bodyText || "";
      const $ = cheerio.load(htmlToParse);
      const resources: DiscoveredFile[] = [];

      const mediaResources = await discovery.findDownloadableResources($, page.url);
      this.log("EXTRACT", `discovery found=${mediaResources.length}`, {
        url: page.url,
        links: mediaResources.map((r) => r.url).slice(0, 5),
      });

      const videoSources = extractors.extractVideoSources($, page.url);
      const audioSources = extractors.extractAudioSources($, page.url);
      const downloadLinks = extractors.extractDownloadLinks($, page.url);

      resources.push(...mediaResources, ...videoSources, ...audioSources, ...downloadLinks);

      this.log("EXTRACT", `total=${resources.length} from=${page.url}`, {
        mediaResources: mediaResources.length,
        videoSources: videoSources.length,
        audioSources: audioSources.length,
        downloadLinks: downloadLinks.length,
      });

      return resources;
    } catch (e) {
      this.log("EXTRACT", `error: ${e instanceof Error ? e.message : "unknown"}`, { url: page.url });
      return [];
    }
  }

  private buildPageContext($: cheerio.CheerioAPI, url: string, rawHtml: string): PageContext {
    const title =
      $("title").text().trim() ||
      $('meta[property="og:title"]').attr("content") ||
      $("h1").first().text().trim() ||
      null;

    const metaDescription =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      null;

    const headings: string[] = [];
    $("h1, h2, h3").each((_, el) => {
      const text = $(el).text().trim();
      if (text) headings.push(text);
    });

    const breadcrumbs: string[] = [];
    $('nav[aria-label*="breadcrumb"] a, .breadcrumb a, [itemtype*="BreadcrumbList"] a').each((_, el) => {
      const text = $(el).text().trim();
      if (text) breadcrumbs.push(text);
    });

    const links: Array<{ href: string; text: string }> = [];
    const seen = new Set<string>();
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      try {
        const normalized = normalizeUrl(href, url);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          links.push({ href: normalized, text: $(el).text().trim() });
        }
      } catch {
        // skip
      }
    });

    const structuredData: Record<string, unknown>[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        structuredData.push(JSON.parse($(el).html() || ""));
      } catch {
        // skip
      }
    });

    const bodyText = $("body").text().substring(0, 3000);

    const metadata: Record<string, string> = {};
    $('meta[property="og:image"]').each((_, el) => {
      const content = $(el).attr("content");
      if (content) metadata["og:image"] = content;
    });
    $('meta[property="og:title"]').each((_, el) => {
      const content = $(el).attr("content");
      if (content) metadata["og:title"] = content;
    });
    $('meta[property="og:description"]').each((_, el) => {
      const content = $(el).attr("content");
      if (content) metadata["og:description"] = content;
    });

    return {
      url,
      title,
      metaDescription,
      headings,
      breadcrumbs,
      links,
      structuredData,
      bodyText,
      rawHtml,
      metadata,
    };
  }

  private async fetchAndParsePage(url: string, _depth: number): Promise<PageContext | null> {
    if (this.visited.has(url)) return null;
    this.visited.add(url);
    this.pagesCrawled++;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!response.ok) return null;

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        return null;
      }

      const html = await response.text();
      const $ = cheerio.load(html);
      return this.buildPageContext($, url, html);
    } catch {
      return null;
    }
  }

  private async runDiagnostics(url: string): Promise<AccessDiagnostics> {
    const diagnostics: AccessDiagnostics = {
      accessStatus: "UNKNOWN",
      httpStatus: null,
      finalUrl: url,
      contentType: null,
      contentLength: null,
      redirectCount: 0,
      robotsStatus: null,
      serverHeaders: {},
      tlsValid: true,
      dnsResolved: true,
      crawlStarted: false,
    };

    try {
      this.log("FETCH", `requesting ${url}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
      });

      clearTimeout(timeout);

      diagnostics.httpStatus = response.status;
      diagnostics.finalUrl = response.url || url;
      diagnostics.contentType = response.headers.get("content-type");
      diagnostics.contentLength = parseInt(response.headers.get("content-length") || "0") || null;

      response.headers.forEach((value, key) => {
        if (["server", "x-powered-by"].includes(key.toLowerCase())) {
          diagnostics.serverHeaders[key] = value;
        }
      });

      diagnostics.accessStatus = this.classifyHttpStatus(response.status);
      diagnostics.crawlStarted = response.ok;

      this.log("FETCH", `status=${response.status}`, {
        contentType: diagnostics.contentType,
        accessStatus: diagnostics.accessStatus,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message.toLowerCase() : "";
      if (msg.includes("timeout") || msg.includes("aborted")) {
        diagnostics.accessStatus = "TIMEOUT";
      } else if (msg.includes("enotfound")) {
        diagnostics.accessStatus = "DNS_ERROR";
        diagnostics.dnsResolved = false;
      } else if (msg.includes("tls") || msg.includes("ssl") || msg.includes("certificate")) {
        diagnostics.accessStatus = "TLS_ERROR";
        diagnostics.tlsValid = false;
      } else {
        diagnostics.accessStatus = "UNKNOWN";
      }
      this.log("FETCH", `error: ${diagnostics.accessStatus}`);
    }

    return diagnostics;
  }

  private classifyHttpStatus(status: number): AccessStatus {
    if (status >= 200 && status < 300) return "ACCESSIBLE";
    if (status === 401) return "UNAUTHORIZED_401";
    if (status === 403) return "BLOCKED_403";
    if (status === 404) return "NOT_FOUND_404";
    if (status === 429) return "RATE_LIMITED_429";
    if (status >= 300 && status < 400) return "REDIRECT_ERROR";
    if (status >= 500) return "SERVER_ERROR_5XX";
    return "UNKNOWN";
  }

  private mapAccessToAnalysis(access: AccessStatus): { status: AnalysisStatus; message: string } {
    switch (access) {
      case "BLOCKED_403":
        return {
          status: "PROTECTED",
          message: "BulkForge reached this domain, but the server refused the analysis request (HTTP 403). This usually means the site requires a browser session or has automated-access restrictions. Files could not be inspected because the website blocked access.",
        };
      case "UNAUTHORIZED_401":
        return {
          status: "AUTH_REQUIRED",
          message: "This page requires authentication. BulkForge cannot access protected content without user credentials.",
        };
      case "RATE_LIMITED_429":
        return {
          status: "RATE_LIMITED",
          message: "The website is rate limiting requests. BulkForge will not repeatedly retry to avoid further restrictions.",
        };
      case "NOT_FOUND_404":
        return { status: "NOT_FOUND", message: "The requested page does not exist or has been removed." };
      case "SERVER_ERROR_5XX":
        return { status: "SERVER_ERROR", message: "The source website returned a server error." };
      case "DNS_ERROR":
        return { status: "BLOCKED", message: "The domain could not be resolved. Please check the URL." };
      case "TLS_ERROR":
        return { status: "BLOCKED", message: "A secure HTTPS connection could not be established." };
      case "TIMEOUT":
        return { status: "BLOCKED", message: "The source did not respond within the configured timeout." };
      default:
        return { status: "BLOCKED", message: "BulkForge could not access this URL." };
    }
  }

  private async validateResources(resources: DiscoveredFile[]): Promise<DiscoveredFile[]> {
    const validated: DiscoveredFile[] = [];
    const seen = new Set<string>();

    for (const resource of resources) {
      const normalized = normalizeUrl(resource.url);
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      const validation = await resourceValidator.validateResource(resource);
      validated.push({
        ...resource,
        downloadable: validation.downloadable,
        downloadBlocked: validation.reason,
        errorState: validation.errorState,
        quality: resource.quality || this.guessQualityFromUrl(resource.url),
      });
    }

    return validated;
  }

  private guessQualityFromUrl(url: string): Quality | undefined {
    const lower = url.toLowerCase();
    if (lower.includes("1080") || lower.includes("1080p")) return "1080p";
    if (lower.includes("720") || lower.includes("720p")) return "720p";
    if (lower.includes("480") || lower.includes("480p")) return "480p";
    if (lower.includes("360") || lower.includes("360p")) return "360p";
    return undefined;
  }

  private extractAvailableQualities(files: DiscoveredFile[]): Quality[] {
    const qualitySet = new Set<Quality>();
    for (const file of files) {
      if (file.quality) qualitySet.add(file.quality);
    }
    const all: Quality[] = ["360p", "480p", "720p", "1080p"];
    if (qualitySet.size === 0) return all;
    return all.filter((q) => qualitySet.has(q));
  }

  private resolveTitle(page: PageContext, ai: AIPageAnalysis | null): string {
    if (ai?.collectionName) return ai.collectionName;
    if (ai?.target?.title) return ai.target.title;
    if (this.intent.requestedTitle) return this.intent.requestedTitle;
    if (this.intent.derivedTitle) return this.intent.derivedTitle;
    if (page.title) return page.title;
    return "Untitled Collection";
  }

  private buildResult(overrides: Partial<AnalysisResult>): AnalysisResult {
    return {
      jobId: this.jobId,
      status: "ANALYZING",
      accessStatus: "UNKNOWN",
      domain: "",
      originalUrl: "",
      finalUrl: "",
      title: null,
      description: null,
      thumbnail: null,
      crawl: { pagesDiscovered: 0, pagesVisited: 0, pagesBlocked: 0, pagesFailed: 0 },
      files: [],
      statistics: { discovered: 0, downloadable: 0, inaccessible: 0, unsupported: 0, totalSize: 0 },
      availableQualities: [],
      message: "",
      details: {
        accessStatus: "UNKNOWN",
        httpStatus: null,
        finalUrl: "",
        contentType: null,
        contentLength: null,
        redirectCount: 0,
        robotsStatus: null,
        serverHeaders: {},
        tlsValid: true,
        dnsResolved: true,
        crawlStarted: false,
      },
      warnings: this.warnings,
      ...overrides,
    };
  }
}

export async function analyzeUrl(url: string): Promise<AnalysisResult> {
  const crawler = new TargetedCrawler(url);
  return crawler.analyze(url);
}
