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
  CrawlPageType,
  HostLink,
  MediaResource,
  PageClassification,
} from "../types";
import { parseUserIntent } from "../lib/intent-parser";
import { rankLinks } from "../lib/relevance-scorer";
import { analyzePageWithAI } from "../lib/ai-analyzer";
import { discovery } from "../discovery/index";
import { extractors } from "../extractors/index";
import { resourceValidator } from "../validators/resource-validator";
import { siteDiscovery } from "../discovery/site-discovery";
import { normalizeUrl, getBaseDomain } from "../lib/utils";
import { USER_AGENT, CRAWL_TIMEOUT_MS, CRAWL_MAX_DEPTH, CRAWL_MAX_PAGES } from "../lib/constants";
import { logger, generateJobId } from "../lib/logger";
import { classifyPage } from "../resolver/page-classifier";
import { filterLinksByTitle, detectHostLinks, isEmbedUrl, isTrailerUrl, detectSeasonPack, extractEpisodeRangeFromText } from "../resolver/index";

interface CrawlCandidate {
  url: string;
  depth: number;
  score: number;
  reason: string;
  priority: "high" | "medium" | "low";
  classification?: PageClassification;
}

class TargetedCrawler {
  private jobId: string;
  private visited = new Set<string>();
  private failed = new Set<string>();
  private collectedResources: DiscoveredFile[] = [];
  private hostLinks: HostLink[] = [];
  private warnings: AnalysisWarning[] = [];
  private startTime: number;
  private intent: UserIntent;
  private aiAnalysis: AIPageAnalysis | null = null;
  private pagesCrawled = 0;
  private entryPageType: CrawlPageType = "unknown";
  private discoveryQueue: CrawlCandidate[] = [];
  private maxDepth: number;
  private maxPages: number;

  constructor(inputUrl: string, jobId?: string) {
    this.jobId = jobId || generateJobId();
    this.startTime = Date.now();
    this.intent = parseUserIntent(inputUrl);
    this.maxDepth = CRAWL_MAX_DEPTH;
    this.maxPages = CRAWL_MAX_PAGES;
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

    this.log("NORMALIZE", `domain=${domain} entry=${normalizedEntry}`);

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

    this.log("CRAWL", "beginning general-purpose site discovery");

    const entryPage = await this.fetchAndParsePage(normalizedEntry, 0);
    if (!entryPage) {
      return this.buildResult({
        status: "BLOCKED",
        accessStatus: diagnostics.accessStatus === "ACCESSIBLE" ? "BLOCKED_403" : diagnostics.accessStatus,
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

    this.entryPageType = entryPage.pageType || "unknown";

    const entryClassification = classifyPage(normalizedEntry, entryPage.rawHtml);
    this.log("CLASSIFICATION", `page_type=${entryClassification.classification} confidence=${entryClassification.confidence}`, {
      reasons: entryClassification.reasons,
      scores: entryClassification.scores,
    });

    this.log("EXTRACT", `page_type=${this.entryPageType} title="${entryPage.title}" links=${entryPage.links.length}`);

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

    const allResources: DiscoveredFile[] = [];

    const entryResources = await this.extractResourcesFromPage(entryPage);
    allResources.push(...entryResources);

    this.log("EXTRACT", `entry_page resources=${entryResources.length}`);

    const filteredEntryLinks = filterLinksByTitle(
      entryPage.links,
      this.intent,
      this.jobId,
      `entry_page`
    );
    this.log("TITLE_FILTER", `entry_page kept=${filteredEntryLinks.length}/${entryPage.links.length}`);

    const entryHostLinks = detectHostLinks(
      cheerio.load(entryPage.rawHtml || ""),
      normalizedEntry,
      this.jobId
    );
    this.hostLinks.push(...entryHostLinks);

    const candidateLinks = this.buildCandidateList(entryPage, 0, filteredEntryLinks);
    this.log("DISCOVERY", `initial_candidates=${candidateLinks.length}`);

    this.discoveryQueue.push(...candidateLinks);

    await this.processCrawlQueue(allResources);

    this.log("VALIDATION", `total_candidates=${allResources.length} host_links=${this.hostLinks.length}`);

    const uniqueResources = this.deduplicateResources(allResources);

    const validatedResources = await this.validateResources(uniqueResources);

    const downloadable = validatedResources.filter((f) => f.downloadable);
    const inaccessible = validatedResources.filter((f) => !f.downloadable);
    const totalSize = downloadable.reduce((sum, f) => sum + (f.size || 0), 0);

    const inaccessibleCount = inaccessible.length;
    const accessibleCount = downloadable.length;

    this.log("VALIDATION", `downloadable=${accessibleCount} inaccessible=${inaccessibleCount} host_links=${this.hostLinks.length}`, {
      downloadableUrls: downloadable.map((f) => f.url).slice(0, 10),
      inaccessibleReasons: inaccessible.map((f) => ({ url: f.url, reason: f.downloadBlocked })).slice(0, 10),
      hostLinkSamples: this.hostLinks.slice(0, 5).map((h) => ({
        url: h.landingUrl,
        filename: h.filename,
        confidence: h.confidence,
      })),
    });

    const title = this.resolveTitle(entryPage, this.aiAnalysis);
    const qualities = this.extractAvailableQualities(downloadable);

    this.log("QUALITY", `available=${qualities.join(",")}`);

    let status: AnalysisStatus;
    let message: string;

    const hasDiscovered = accessibleCount > 0 || this.hostLinks.length > 0;

    if (hasDiscovered) {
      status = "MEDIA_FOUND";
      const parts: string[] = [];
      if (accessibleCount > 0) parts.push(`${accessibleCount} downloadable resources`);
      if (this.hostLinks.length > 0) parts.push(`${this.hostLinks.length} host-linked resources`);
      if (inaccessibleCount > 0) parts.push(`${inaccessibleCount} inaccessible`);
      message = `BulkForge discovered ${parts.join(", ")}.`;
    } else if (uniqueResources.length > 0) {
      status = "NO_MEDIA_FOUND";
      message = `Found ${uniqueResources.length} candidates, but none could be verified as downloadable. The resources may require authentication, be DRM-protected, or be temporarily unavailable.`;
    } else {
      status = "NO_MEDIA_FOUND";
      message = "No downloadable resources were discovered. The content may be dynamically loaded, behind authentication, or the page may not contain publicly accessible media.";
    }

    this.log("RESULT", `status=${status}`);

    return this.buildResult({
      status,
      accessStatus: "ACCESSIBLE",
      domain,
      originalUrl: inputUrl,
      finalUrl: diagnostics.finalUrl,
      title,
      description: this.aiAnalysis?.description || entryPage.metadata.description || entryPage.metaDescription || null,
      thumbnail: entryPage.metadata["og:image"] || null,
      crawl: {
        pagesDiscovered: this.visited.size + this.failed.size,
        pagesVisited: this.visited.size,
        pagesBlocked: 0,
        pagesFailed: this.failed.size,
      },
      files: validatedResources,
      statistics: {
        discovered: uniqueResources.length + this.hostLinks.length,
        downloadable: accessibleCount + this.hostLinks.length,
        inaccessible: inaccessibleCount,
        unsupported: 0,
        totalSize,
      },
      availableQualities: qualities,
      message,
      details: diagnostics,
    });
  }

  private async processCrawlQueue(
    allResources: DiscoveredFile[]
  ): Promise<void> {
    while (this.discoveryQueue.length > 0 && this.pagesCrawled < this.maxPages) {
      const candidate = this.discoveryQueue.shift()!;
      if (this.visited.has(candidate.url)) continue;

      const page = await this.fetchAndParsePage(candidate.url, candidate.depth);
      if (!page) {
        this.failed.add(candidate.url);
        continue;
      }

      this.log("CRAWL", `depth=${candidate.depth} url=${candidate.url}`);

      const pageClassification = classifyPage(candidate.url, page.rawHtml);
      this.log("CLASSIFICATION", `url=${candidate.url} type=${pageClassification.classification} confidence=${pageClassification.confidence}`, {
        reasons: pageClassification.reasons,
      });

      const isSiteWideIndex = this.detectSiteWideIndex(page);
      if (isSiteWideIndex) {
        this.log("CLASSIFICATION", `SITE_WIDE_INDEX detected at ${candidate.url} — skipping extraction, too many distinct titles`);
        this.warnings.push({
          code: "OVER_SCOPED_CRAWL",
          message: `Page at ${candidate.url} appears to be a site-wide index with many unrelated titles. Skipping to prevent cross-title contamination.`,
        });
        continue;
      }

      const pageResources = await this.extractResourcesFromPage(page);
      const filteredLinks = filterLinksByTitle(
        page.links,
        this.intent,
        this.jobId,
        `depth=${candidate.depth}`
      );
      this.log("TITLE_FILTER", `depth=${candidate.depth} kept=${filteredLinks.length}/${page.links.length}`);

      const pageHostLinks = detectHostLinks(
        cheerio.load(page.rawHtml || ""),
        candidate.url,
        this.jobId
      );
      this.hostLinks.push(...pageHostLinks);

      if (pageClassification.classification === "CONTENT_INDEX") {
        this.log("CLASSIFICATION", `CONTENT_INDEX detected at depth=${candidate.depth}, following one hop deeper`);
        const indexCandidates = this.buildCandidateList(page, candidate.depth, filteredLinks);
        for (const nc of indexCandidates) {
          if (!this.visited.has(nc.url) && !this.failed.has(nc.url)) {
            const exists = this.discoveryQueue.some((c) => c.url === nc.url);
            if (!exists) {
              this.discoveryQueue.push(nc);
            }
          }
        }
      }

      allResources.push(...pageResources);
      this.log("EXTRACTION", `url=${candidate.url} resources=${pageResources.length}`);

      if (candidate.depth + 1 < this.maxDepth) {
        const newCandidates = this.buildCandidateList(page, candidate.depth + 1, filteredLinks);
        for (const nc of newCandidates) {
          if (!this.visited.has(nc.url) && !this.failed.has(nc.url)) {
            const exists = this.discoveryQueue.some((c) => c.url === nc.url);
            if (!exists) {
              this.discoveryQueue.push(nc);
            }
          }
        }
        this.discoveryQueue.sort((a, b) => {
          const priorityOrder = { high: 0, medium: 1, low: 2 };
          const pa = priorityOrder[a.priority];
          const pb = priorityOrder[b.priority];
          if (pa !== pb) return pa - pb;
          return b.score - a.score;
        });
      }
    }
  }

  private mergeAIAnalysis(analysis: AIPageAnalysis): void {
    if (analysis.target.title && !this.intent.requestedTitle) {
      this.intent.requestedTitle = analysis.target.title;
    }
    if (analysis.target.season && !this.intent.requestedSeason) {
      this.intent.requestedSeason = String(analysis.target.season);
    }
  }

  private buildCandidateList(
    page: PageContext,
    depth: number,
    preFilterLinks?: Array<{ href: string; text: string; titleScore: number }>
  ): CrawlCandidate[] {
    const candidates: CrawlCandidate[] = [];

    const linksToScore = preFilterLinks
      ? preFilterLinks.map((l) => ({ href: l.href, text: l.text }))
      : page.links;

    const scored = rankLinks(linksToScore, this.intent, page);

    for (const s of scored) {
      if (s.decision === "QUEUE" && s.total >= 0.25) {
        if (!this.visited.has(s.url) && !this.failed.has(s.url)) {
          const priority: CrawlCandidate["priority"] =
            s.total >= 0.6 ? "high" : s.total >= 0.4 ? "medium" : "low";
          candidates.push({
            url: s.url,
            depth,
            score: s.total,
            reason: s.reason,
            priority,
          });
        }
      }
    }

    candidates.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      const pa = priorityOrder[a.priority];
      const pb = priorityOrder[b.priority];
      if (pa !== pb) return pa - pb;
      return b.score - a.score;
    });

    return candidates.slice(0, this.maxPages - this.visited.size);
  }

  private async extractResourcesFromPage(page: PageContext): Promise<DiscoveredFile[]> {
    try {
      const htmlToParse = page.rawHtml || page.bodyText || "";
      const $ = cheerio.load(htmlToParse);
      const resources: DiscoveredFile[] = [];

      const mediaResources = await discovery.findDownloadableResources($, page.url);
      const videoSources = extractors.extractVideoSources($, page.url);
      const audioSources = extractors.extractAudioSources($, page.url);
      const downloadLinks = extractors.extractDownloadLinks($, page.url);

      resources.push(...mediaResources, ...videoSources, ...audioSources, ...downloadLinks);

      const filtered: DiscoveredFile[] = [];
      for (const resource of resources) {
        if (!resource.sourcePage) {
          resource.sourcePage = page.url;
        }

        if (isEmbedUrl(resource.url)) {
          this.log("EXTRACT", `embed_excluded url=${resource.url}`);
          continue;
        }

        if (isTrailerUrl(resource.url, resource.name)) {
          this.log("EXTRACT", `trailer_excluded url=${resource.url}`);
          continue;
        }

        const isPack = detectSeasonPack(resource.name) || detectSeasonPack(resource.url);
        if (isPack) {
          resource.isSeasonPack = true;
          const range = extractEpisodeRangeFromText(`${resource.name} ${resource.url}`);
          if (range) {
            resource.episodeRange = `${range.start}-${range.end}`;
          }
          this.log("EXTRACT", `season_pack_detected url=${resource.url} range=${resource.episodeRange || "unknown"}`);
        }

        filtered.push(resource);
      }

      return filtered;
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
      if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return;
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
        const parsed = JSON.parse($(el).html() || "");
        if (Array.isArray(parsed)) {
          structuredData.push(...parsed);
        } else {
          structuredData.push(parsed);
        }
      } catch {
        // skip
      }
    });

    const bodyText = $("body").text().substring(0, 5000);

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
    $('meta[name="description"]').each((_, el) => {
      const content = $(el).attr("content");
      if (content) metadata["description"] = content;
    });
    const canonicalLink = $('link[rel="canonical"]').attr("href");
    if (canonicalLink) metadata["canonical"] = canonicalLink;

    const pageType = siteDiscovery.classifyPageType($, url, rawHtml);

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
      pageType,
    };
  }

  private async fetchAndParsePage(url: string, _depth?: number): Promise<PageContext | null> {
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

      if (!response.ok) {
        this.failed.add(url);
        return null;
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        return null;
      }

      const html = await response.text();
      const $ = cheerio.load(html);
      return this.buildPageContext($, url, html);
    } catch {
      this.failed.add(url);
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
        if (["server", "x-powered-by", "x-cache", "cf-ray"].includes(key.toLowerCase())) {
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

  private detectSiteWideIndex(page: PageContext): boolean {
    const targetTitle = (this.intent.requestedTitle || this.intent.derivedTitle || "").toLowerCase();
    const targetTokens = targetTitle ? new Set(targetTitle.split(/\s+/).filter((w) => w.length > 3)) : new Set<string>();

    const linkTexts: string[] = [];
    for (const link of page.links) {
      if (link.text.length > 5 && link.text.length < 200) {
        linkTexts.push(link.text.toLowerCase());
      }
    }

    if (linkTexts.length < 10) return false;

    const DISTINCT_TITLE_MIN_WORDS = 3;
    const distinctTitles = new Map<string, number>();

    for (const text of linkTexts) {
      const words = text.split(/\s+/).filter((w) => w.length > 3);
      if (words.length < DISTINCT_TITLE_MIN_WORDS) continue;

      const titleKey = words.slice(0, 5).join(" ");
      if (targetTokens.size > 0) {
        let overlap = 0;
        for (const w of words) {
          if (targetTokens.has(w)) overlap++;
        }
        if (overlap >= Math.min(2, targetTokens.size)) continue;
      }

      distinctTitles.set(titleKey, (distinctTitles.get(titleKey) || 0) + 1);
    }

    if (distinctTitles.size >= 5) {
      this.log("CLASSIFICATION", `site_wide_index detected: ${distinctTitles.size} distinct titles on one page`, {
        sample: Array.from(distinctTitles.keys()).slice(0, 5),
      });
      return true;
    }

    return false;
  }

  private deduplicateResources(resources: DiscoveredFile[]): DiscoveredFile[] {
    const seen = new Map<string, DiscoveredFile>();
    for (const resource of resources) {
      const normalized = normalizeUrl(resource.url);
      if (!seen.has(normalized)) {
        seen.set(normalized, resource);
      }
    }
    return Array.from(seen.values());
  }

  private async validateResources(resources: DiscoveredFile[]): Promise<DiscoveredFile[]> {
    const validated: DiscoveredFile[] = [];

    for (const resource of resources) {
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
    const qualityMatch = lower.match(/\b(\d{3,4})p\b/);
    if (qualityMatch) return `${qualityMatch[1]}p`;
    return undefined;
  }

  private extractAvailableQualities(files: DiscoveredFile[]): Quality[] {
    const qualitySet = new Set<Quality>();
    for (const file of files) {
      if (file.quality) qualitySet.add(file.quality);
    }
    return Array.from(qualitySet).sort((a, b) => {
      const numA = parseInt(a) || 0;
      const numB = parseInt(b) || 0;
      return numA - numB;
    });
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
