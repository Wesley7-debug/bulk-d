import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
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
import {
  USER_AGENT,
  CRAWL_TIMEOUT_MS,
  CRAWL_MAX_DEPTH,
  CRAWL_MAX_PAGES,
} from "../lib/constants";
import { logger, generateJobId } from "../lib/logger";
import { classifyPage } from "../resolver/page-classifier";
import {
  filterLinksByTitle,
  detectHostLinks,
  isEmbedUrl,
  isTrailerUrl,
  detectSeasonPack,
  extractEpisodeRangeFromText,
  resolveStatic,
  resolveHostLink,
} from "../resolver/index";
import { BaseAdapter } from "./base-adapter";
import { GenericPageAdapter } from "./generic-page-adapter";

interface CrawlCandidate {
  url: string;
  depth: number;
  score: number;
  reason: string;
  priority: "high" | "medium" | "low";
  classification?: PageClassification;
}

interface EpisodeCollectionBoundary {
  selector: string;
  html: string;
  candidateLinks: Array<{ href: string; text: string }>;
}

export class TargetedCrawler {
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
  private crawlOnly: boolean;

  constructor(inputUrl: string, jobId?: string, crawlOnly?: boolean) {
    this.jobId = jobId || generateJobId();
    this.startTime = Date.now();
    this.intent = parseUserIntent(inputUrl);
    this.maxDepth = CRAWL_MAX_DEPTH;
    this.maxPages = CRAWL_MAX_PAGES;
    this.crawlOnly = crawlOnly || false;
  }

  private log(
    stage: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    logger.log(this.jobId, stage, message, data);
  }

  private adapters: BaseAdapter[] = [new GenericPageAdapter()];

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
      const { status, message } = this.mapAccessToAnalysis(
        diagnostics.accessStatus,
      );
      this.log("RESULT", `status=${status}`, {
        accessStatus: diagnostics.accessStatus,
      });
      return this.buildResult({
        status,
        accessStatus: diagnostics.accessStatus,
        domain,
        originalUrl: inputUrl,
        finalUrl: diagnostics.finalUrl,
        title: null,
        description: null,
        thumbnail: null,
        crawl: {
          pagesDiscovered: 0,
          pagesVisited: 0,
          pagesBlocked: 0,
          pagesFailed: 0,
        },
        files: [],
        statistics: {
          discovered: 0,
          downloadable: 0,
          inaccessible: 0,
          unsupported: 0,
          totalSize: 0,
        },
        availableQualities: [],
        message,
        details: diagnostics,
      });
    }

    for (const adapter of this.adapters) {
      if (adapter.canHandle(normalizedEntry)) {
        this.log("ADAPTER", `using adapter=${adapter.name} url=${normalizedEntry}`);
        try {
          const adapterResult = await adapter.analyze(normalizedEntry);
          const adapterFiles: DiscoveredFile[] = adapterResult.files.map((f) => ({
            url: f.url,
            resourceId: normalizeUrl(f.url),
            name: f.name,
            quality: f.quality,
            parsedTitle: undefined,
            season: f.season,
            episode: f.episode,
            extension: undefined,
            collectionScope: "in_scope" as const,
            fileType: f.fileType,
            mimeType: "application/octet-stream",
            size: f.size,
            downloadable: true,
            sourcePage: f.sourcePage || normalizedEntry,
            resolveStatus: "ready_to_resolve" as const,
          }));

          if (adapterFiles.length > 0) {
            this.log("ADAPTER", `adapter=${adapter.name} discovered=${adapterFiles.length}`);
            const scoped = this.applyCollectionScope(adapterFiles);
            const unique = this.deduplicateResources(scoped);
            const validated = await this.validateResources(unique);

            for (const hl of this.hostLinks) {
              const match = validated.find((r) => normalizeUrl(r.sourcePage || "") === normalizeUrl(hl.sourcePage));
              if (match) {
                match.url = hl.landingUrl;
                match.resourceId = normalizeUrl(hl.landingUrl);
                if (hl.filename) match.name = hl.filename;
                match.downloadable = true;
                match.downloadBlocked = undefined;
                match.errorState = undefined;
                match.resolveStatus = "ready_to_resolve";
              }
            }

            const allFiles = this.deduplicateResources(validated);

            if (!this.crawlOnly) {
              const toResolve = allFiles.filter((f) => f.downloadable && !f.resolvedUrl);
              const resolveResults = await this.resolveAllInParallel(toResolve, 5);

              let resolved = 0;
              let resolveFailed = 0;
              for (let i = 0; i < toResolve.length; i++) {
                const resource = toResolve[i];
                const result = resolveResults[i];
                if (result.status === "fulfilled" && result.value) {
                  resource.resolvedUrl = result.value.url;
                  resource.name = result.value.filename || resource.name;
                  resource.size = result.value.size || resource.size;
                  if (result.value.mimeType) resource.mimeType = result.value.mimeType;
                  resource.resolveStatus = "resolved";
                  resolved++;
                } else {
                  resource.resolveStatus = "resolution_failed";
                  resolveFailed++;
                }
              }

              this.log("RESOLVE_DONE", `resolved=${resolved} failed=${resolveFailed} total=${toResolve.length}`);
            } else {
              this.log("CRAWL_ONLY", `skipping resolution for ${allFiles.length} files`);
            }

            const downloadable = allFiles.filter((f) => f.downloadable);
            const inaccessible = allFiles.filter((f) => !f.downloadable);

            if (downloadable.length === 0 && allFiles.length > 0) {
              this.log("ADAPTER", `adapter=${adapter.name} found ${allFiles.length} resources but none downloadable — falling back to generic crawl`);
            } else {
              const totalSize = downloadable.reduce((sum, f) => sum + (f.size || 0), 0);
              const qualities = this.extractAvailableQualities(downloadable);
              const title = adapterResult.title || "Untitled Collection";

              return this.buildResult({
                status: downloadable.length > 0 ? "MEDIA_FOUND" : "NO_MEDIA_FOUND",
                accessStatus: "ACCESSIBLE",
                domain,
                originalUrl: inputUrl,
                finalUrl: diagnostics.finalUrl,
                title,
                description: adapterResult.description || null,
                thumbnail: adapterResult.thumbnailUrl || null,
                crawl: {
                  pagesDiscovered: 1,
                  pagesVisited: 1,
                  pagesBlocked: 0,
                  pagesFailed: 0,
                },
                files: allFiles,
                statistics: {
                  discovered: allFiles.length,
                  downloadable: downloadable.length,
                  inaccessible: inaccessible.length,
                  unsupported: 0,
                  totalSize,
                },
                availableQualities: qualities,
                message: `Bulk-D discovered ${downloadable.length} downloadable resources via ${adapter.name}.`,
                details: diagnostics,
              });
            }
          }
        } catch (err) {
          this.log("ADAPTER", `adapter=${adapter.name} error: ${err instanceof Error ? err.message : "unknown"}, falling back to generic crawl`);
        }
      }
    }

    this.log("CRAWL", "source=provided_url");

    const entryPage = await this.fetchAndParsePage(normalizedEntry, 0);
    if (!entryPage) {
      return this.buildResult({
        status: "BLOCKED",
        accessStatus:
          diagnostics.accessStatus === "ACCESSIBLE"
            ? "BLOCKED_403"
            : diagnostics.accessStatus,
        domain,
        originalUrl: inputUrl,
        finalUrl: diagnostics.finalUrl,
        title: null,
        description: null,
        thumbnail: null,
        crawl: {
          pagesDiscovered: 0,
          pagesVisited: 0,
          pagesBlocked: 0,
          pagesFailed: 0,
        },
        files: [],
        statistics: {
          discovered: 0,
          downloadable: 0,
          inaccessible: 0,
          unsupported: 0,
          totalSize: 0,
        },
        availableQualities: [],
        message: "Could not fetch the entry page.",
        details: diagnostics,
      });
    }

    this.entryPageType = entryPage.pageType || "unknown";

    const entryClassification = classifyPage(
      normalizedEntry,
      entryPage.rawHtml,
    );
    this.log(
      "CLASSIFICATION",
      `page_type=${entryClassification.classification} confidence=${entryClassification.confidence}`,
      {
        reasons: entryClassification.reasons,
        scores: entryClassification.scores,
      },
    );

    this.log(
      "EXTRACT",
      `page_type=${this.entryPageType} title="${entryPage.title}" links=${entryPage.links.length}`,
    );

    try {
      this.aiAnalysis = await analyzePageWithAI(entryPage, this.intent);
      if (this.aiAnalysis) {
        this.log(
          "AI",
          `pageType=${this.aiAnalysis.pageType} confidence=${this.aiAnalysis.confidence}`,
          {
            targetTitle: this.aiAnalysis.target.title,
            targetSeason: this.aiAnalysis.target.season,
            relevantLinks: this.aiAnalysis.relevantLinks.length,
            irrelevantLinks: this.aiAnalysis.irrelevantLinks.length,
          },
        );
        this.mergeAIAnalysis(this.aiAnalysis);
      } else {
        this.log("AI", "no AI available, using deterministic scoring only");
      }
    } catch (e) {
      this.log(
        "AI",
        `error: ${e instanceof Error ? e.message : "unknown"}, falling back to deterministic`,
      );
    }

    const allResources: DiscoveredFile[] = [];
    const collectionBoundary = this.findEpisodeCollection(entryPage);
    const entryResources = await this.extractResourcesFromPage(
      entryPage,
      collectionBoundary?.html,
    );
    allResources.push(...entryResources);

    this.log("EXTRACT", `entry_page resources=${entryResources.length}`);

    const entryDiscoveryLinks = collectionBoundary
      ? collectionBoundary.candidateLinks
      : this.extractEpisodeLinks(
          cheerio.load(entryPage.rawHtml || "")("body"),
          normalizedEntry,
        );
    let filteredEntryLinks = filterLinksByTitle(
      entryDiscoveryLinks,
      this.intent,
      this.jobId,
      `entry_page`,
    );

    filteredEntryLinks = this.filterLinksByAIAnalysis(filteredEntryLinks);
    if (this.aiAnalysis) {
      this.log(
        "AI_FILTER",
        `after_ai_filter kept=${filteredEntryLinks.length}`,
      );
    }

    this.log(
      "TITLE_FILTER",
      `entry_page kept=${filteredEntryLinks.length}/${entryDiscoveryLinks.length}`,
    );
    this.log(
      "CRAWL",
      `collection_container=${collectionBoundary?.selector || "none"}`,
    );
    this.log("CRAWL", `candidate_links=${entryDiscoveryLinks.length}`);
    this.log("CRAWL", `episode_links=${filteredEntryLinks.length}`);
    this.log(
      "CRAWL",
      `rejected_unrelated=${entryPage.links.length - filteredEntryLinks.length}`,
    );

    for (let i = 0; i < filteredEntryLinks.length; i++) {
      this.log(
        "TITLE_FILTER",
        `KEPT #${i + 1} href="${filteredEntryLinks[i].href}" text="${filteredEntryLinks[i].text}"`,
      );
    }

    const entryHostLinks = detectHostLinks(
      cheerio.load(entryPage.rawHtml || ""),
      normalizedEntry,
      this.jobId,
    );
    this.hostLinks.push(...entryHostLinks);

    const candidateLinks = this.buildCandidateList(
      entryPage,
      1,
      filteredEntryLinks,
    );
    this.log("DISCOVERY", `initial_candidates=${candidateLinks.length}`);

    this.discoveryQueue.push(...candidateLinks);

    await this.processCrawlQueue(allResources);
    this.log("CRAWL", `final_resources=${allResources.length}`);

    this.log(
      "VALIDATION",
      `total_candidates=${allResources.length} host_links=${this.hostLinks.length}`,
    );

    const scopedResources = this.applyCollectionScope(allResources);
    const uniqueResources = this.deduplicateResources(scopedResources);

    const validatedResources = await this.validateResources(uniqueResources);

    const newResources: DiscoveredFile[] = [];

    for (const hl of this.hostLinks) {
      const normalizedSource = normalizeUrl(hl.sourcePage);

      const match = validatedResources.find((r) => {
        const rSource = normalizeUrl(r.sourcePage || "");
        const rUrl = normalizeUrl(r.url);
        return rSource === normalizedSource || rUrl === normalizedSource;
      });

      if (match) {
        match.url = hl.landingUrl;
        match.resourceId = normalizeUrl(hl.landingUrl);
        if (hl.filename) match.name = hl.filename;
        match.downloadable = true;
        match.downloadBlocked = undefined;
        match.errorState = undefined;
        match.resolveStatus = "ready_to_resolve";
        if (hl.fileSize) match.size = undefined;
      } else {
        const hostText = `${hl.filename || ""} ${hl.landingUrl}`.toLowerCase();
        const episodeMatch =
          hostText.match(/\bS(\d{1,2})E(\d{1,3})\b/i) ||
          hostText.match(/\b(?:episode|ep)[\s._-]*(\d{1,3})\b/i);
        const hostSeason = episodeMatch ? parseInt(episodeMatch[1] || "1", 10) : undefined;
        const hostEpisode = episodeMatch ? parseInt(episodeMatch[episodeMatch[0].match(/\bS\d{1,2}E/i) ? 2 : 1], 10) : undefined;

        let merged = false;
        if (hostEpisode !== undefined) {
          const epMatch = validatedResources.find((r) => {
            const rSource = normalizeUrl(r.sourcePage || "");
            if (rSource !== normalizedSource) return false;
            if (r.episode !== undefined && r.episode === hostEpisode) return true;
            const rText = `${r.name} ${r.url}`.toLowerCase();
            const rEpMatch = rText.match(/\b(?:episode|ep)[\s._-]*(\d{1,3})\b/i);
            return rEpMatch && parseInt(rEpMatch[1], 10) === hostEpisode;
          });
          if (epMatch) {
            epMatch.url = hl.landingUrl;
            epMatch.resourceId = normalizeUrl(hl.landingUrl);
            if (hl.filename) epMatch.name = hl.filename;
            epMatch.downloadable = true;
            epMatch.downloadBlocked = undefined;
            epMatch.errorState = undefined;
            epMatch.resolveStatus = "ready_to_resolve";
            if (hostSeason !== undefined) epMatch.season = hostSeason;
            if (hostEpisode !== undefined) epMatch.episode = hostEpisode;
            if (hl.fileSize) epMatch.size = undefined;
            merged = true;
          }
        }

        if (!merged) {
          const bare: DiscoveredFile = {
            url: hl.landingUrl,
            resourceId: normalizeUrl(hl.landingUrl),
            name: hl.filename || hl.landingUrl.split("/").pop() || "host-linked-file",
            fileType: "video" as const,
            mimeType: "text/html",
            size: undefined,
            downloadable: true,
            downloadBlocked: undefined,
            errorState: undefined,
            quality: undefined,
            sourcePage: hl.sourcePage,
            resolveStatus: "ready_to_resolve" as const,
            season: hostSeason,
            episode: hostEpisode,
          };
          if (this.isResourceRelevantToIntent(bare)) {
            const parsed = this.parseResourceMetadata(bare);
            bare.parsedTitle = parsed.title;
            if (!bare.season && parsed.season !== undefined) bare.season = parsed.season;
            if (!bare.episode && parsed.episode !== undefined) bare.episode = parsed.episode;
            if (parsed.quality) bare.quality = parsed.quality;
            if (parsed.extension) bare.extension = parsed.extension;
            newResources.push(bare);
          }
        }
      }
    }

    validatedResources.push(...newResources);
    const allFiles = this.deduplicateResources(validatedResources);

    this.log("RESOLVE_START", `resources_to_resolve=${allFiles.length} crawl_only=${this.crawlOnly}`);

    if (!this.crawlOnly) {
      const resolveConcurrency = 5;
      const toResolve = allFiles.filter((f) => f.downloadable && !f.resolvedUrl);
      const resolveResults = await this.resolveAllInParallel(toResolve, resolveConcurrency);
      let resolved = 0;
      let resolveFailed = 0;
      for (let i = 0; i < toResolve.length; i++) {
        const resource = toResolve[i];
        const result = resolveResults[i];
        if (result.status === "fulfilled" && result.value) {
          resource.resolvedUrl = result.value.url;
          resource.name = result.value.filename || resource.name;
          resource.size = result.value.size || resource.size;
          if (result.value.mimeType) resource.mimeType = result.value.mimeType;
          resource.resolveStatus = "resolved";
          resolved++;
        } else {
          resource.resolveStatus = "resolution_failed";
          resolveFailed++;
        }
      }

      this.log("RESOLVE_DONE", `resolved=${resolved} failed=${resolveFailed} total=${toResolve.length}`);
    } else {
      this.log("CRAWL_ONLY", `skipping resolution for ${allFiles.length} files`);
    }

    const downloadable = allFiles.filter((f) => f.downloadable);
    const inaccessible = allFiles.filter((f) => !f.downloadable);
    const totalSize = downloadable.reduce((sum, f) => sum + (f.size || 0), 0);

    const inaccessibleCount = inaccessible.length;
    const accessibleCount = downloadable.length;

    this.log(
      "VALIDATION",
      `downloadable=${accessibleCount} inaccessible=${inaccessibleCount} host_links=${this.hostLinks.length}`,
      {
        downloadableUrls: downloadable.map((f) => f.url).slice(0, 10),
        inaccessibleReasons: inaccessible
          .map((f) => ({ url: f.url, reason: f.downloadBlocked }))
          .slice(0, 10),
        hostLinkSamples: this.hostLinks.slice(0, 5).map((h) => ({
          url: h.landingUrl,
          filename: h.filename,
          confidence: h.confidence,
        })),
      },
    );

    const title = this.resolveTitle(entryPage, this.aiAnalysis);
    const qualities = this.extractAvailableQualities(downloadable);

    this.log("QUALITY", `available=${qualities.join(",")}`);

    let status: AnalysisStatus;
    let message: string;

    const hasDiscovered = accessibleCount > 0;

    if (hasDiscovered) {
      status = "MEDIA_FOUND";
      const parts: string[] = [];
      if (accessibleCount > 0)
        parts.push(`${accessibleCount} downloadable resources`);
      if (inaccessibleCount > 0)
        parts.push(`${inaccessibleCount} inaccessible`);
      message = `Bulk-D discovered ${parts.join(", ")}.`;
    } else if (uniqueResources.length > 0) {
      status = "NO_MEDIA_FOUND";
      message = `Found ${uniqueResources.length} candidates, but none could be verified as downloadable. The resources may require authentication, be DRM-protected, or be temporarily unavailable.`;
    } else {
      status = "NO_MEDIA_FOUND";
      message =
        "No downloadable resources were discovered. The content may be dynamically loaded, behind authentication, or the page may not contain publicly accessible media.";
    }

    this.log("RESULT", `status=${status}`);

    return this.buildResult({
      status,
      accessStatus: "ACCESSIBLE",
      domain,
      originalUrl: inputUrl,
      finalUrl: diagnostics.finalUrl,
      title,
      description:
        this.aiAnalysis?.description ||
        entryPage.metadata.description ||
        entryPage.metaDescription ||
        null,
      thumbnail: entryPage.metadata["og:image"] || null,
      crawl: {
        pagesDiscovered: this.visited.size + this.failed.size,
        pagesVisited: this.visited.size,
        pagesBlocked: 0,
        pagesFailed: this.failed.size,
      },
      files: allFiles,
      statistics: {
        discovered: allFiles.length,
        downloadable: accessibleCount,
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
    allResources: DiscoveredFile[],
  ): Promise<void> {
    while (
      this.discoveryQueue.length > 0 &&
      this.pagesCrawled < this.maxPages
    ) {
      const candidate = this.discoveryQueue.shift()!;
      if (this.visited.has(candidate.url)) continue;

      const page = await this.fetchAndParsePage(candidate.url, candidate.depth);
      if (!page) {
        this.failed.add(candidate.url);
        continue;
      }

      this.log("CRAWL", `depth=${candidate.depth} url=${candidate.url}`);

      const pageClassification = classifyPage(candidate.url, page.rawHtml);
      this.log(
        "CLASSIFICATION",
        `url=${candidate.url} type=${pageClassification.classification} confidence=${pageClassification.confidence}`,
        {
          reasons: pageClassification.reasons,
        },
      );

      const isSiteWideIndex = this.detectSiteWideIndex(page);
      if (isSiteWideIndex && candidate.depth === 0) {
        this.log(
          "CLASSIFICATION",
          `SITE_WIDE_INDEX detected at ${candidate.url} — skipping extraction, too many distinct titles`,
        );
        this.warnings.push({
          code: "OVER_SCOPED_CRAWL",
          message: `Page at ${candidate.url} appears to be a site-wide index with many unrelated titles. Skipping to prevent cross-title contamination.`,
        });
        continue;
      }

      if (isSiteWideIndex) {
        this.log(
          "CLASSIFICATION",
          `SITE_WIDE_INDEX detected at ${candidate.url} — attempting extraction with relevance filtering`,
        );
      }

      const isContentIndex =
        pageClassification.classification === "CONTENT_INDEX";

      let pageResources: DiscoveredFile[] = [];
      pageResources = await this.extractResourcesFromPage(page);
      pageResources = pageResources.filter((r) =>
        this.isResourceRelevantToIntent(r),
      );

      let filteredLinks = filterLinksByTitle(
        page.links,
        this.intent,
        this.jobId,
        `depth=${candidate.depth}`,
      );
      filteredLinks = this.filterLinksByAIAnalysis(filteredLinks);
      this.log(
        "TITLE_FILTER",
        `depth=${candidate.depth} kept=${filteredLinks.length}/${page.links.length}`,
      );

      const pageHostLinks = detectHostLinks(
        cheerio.load(page.rawHtml || ""),
        candidate.url,
        this.jobId,
      );
      this.hostLinks.push(...pageHostLinks);

      allResources.push(...pageResources);
      this.log(
        "EXTRACTION",
        `url=${candidate.url} resources=${pageResources.length} is_index=${isContentIndex}`,
      );
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

  private filterLinksByAIAnalysis(
    links: Array<{ href: string; text: string; titleScore: number }>,
  ): Array<{ href: string; text: string; titleScore: number }> {
    if (!this.aiAnalysis) return links;

    const irrelevantUrls = new Set(
      this.aiAnalysis.irrelevantLinks
        .filter((l) => l.confidence > 0.7)
        .map((l) => l.url),
    );

    if (irrelevantUrls.size === 0) return links;

    return links.filter((link) => {
      const normalized = normalizeUrl(link.href);
      return !irrelevantUrls.has(normalized) && !irrelevantUrls.has(link.href);
    });
  }

  private isResourceRelevantToIntent(resource: DiscoveredFile): boolean {
    const targetTitle = (
      this.intent.requestedTitle ||
      this.intent.derivedTitle ||
      ""
    ).toLowerCase();
    if (!targetTitle) return true;

    const targetTokens = new Set(
      targetTitle.split(/\s+/).filter((w) => w.length > 2),
    );
    if (targetTokens.size === 0) return true;

    const resourceText = `${resource.url} ${resource.name}`.toLowerCase();
    const sourcePageText = (resource.sourcePage || "").toLowerCase();
    let matchCount = 0;
    let sourceMatchCount = 0;
    for (const token of targetTokens) {
      if (resourceText.includes(token)) matchCount++;
      if (sourcePageText.includes(token)) sourceMatchCount++;
    }

    const ratio = matchCount / targetTokens.size;
    const sourceRatio = sourceMatchCount / targetTokens.size;
    if (ratio >= 0.3 || sourceRatio >= 0.3) return true;

    if (this.intent.requestedSeason) {
      const seasonPattern = new RegExp(
        `s0*${this.intent.requestedSeason}\\b|season[\\s._-]*${this.intent.requestedSeason}`,
        "i",
      );
      if (seasonPattern.test(resourceText) && (ratio > 0 || sourceRatio > 0)) return true;
    }

    return false;
  }

  private buildCandidateList(
    page: PageContext,
    depth: number,
    preFilterLinks?: Array<{ href: string; text: string; titleScore: number }>,
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

  private findEpisodeCollection(
    page: PageContext,
  ): EpisodeCollectionBoundary | null {
    const $ = cheerio.load(page.rawHtml || "");
    const selectors = [
      "main",
      "article",
      '[role="main"]',
      ".entry-content",
      ".post-content",
      ".article-content",
      ".single-post",
      "#content",
    ];
    const titleTokens = (
      this.intent.requestedTitle ||
      this.intent.derivedTitle ||
      ""
    )
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 2);
    let bestScore = -Infinity;
    let bestBoundary: EpisodeCollectionBoundary | null = null;
    const seenHtml = new Set<string>();

    for (const selector of selectors) {
      $(selector).each((_, element) => {
        const container = $(element);
        const html = $.html(element);
        if (!html || seenHtml.has(html)) return;
        seenHtml.add(html);

        const candidateLinks = this.extractEpisodeLinks(container, page.url);
        if (candidateLinks.length < 2) return;

        const containerText = container.text().toLowerCase();
        const titleMatches = titleTokens.filter((token) =>
          containerText.includes(token),
        ).length;
        const seasonSignal =
          this.intent.requestedSeason &&
          new RegExp(
            `(?:season|s)\\s*0*${this.intent.requestedSeason}\\b`,
            "i",
          ).test(containerText)
            ? 8
            : 0;
        const selectorWeight =
          selector === "main" ||
          selector === "article" ||
          selector === '[role="main"]'
            ? 2
            : 4;
        const score =
          candidateLinks.length * 10 +
          titleMatches * 3 +
          seasonSignal +
          selectorWeight;

        if (score > bestScore) {
          bestScore = score;
          bestBoundary = { selector, html, candidateLinks };
        }
      });
    }

    return bestBoundary;
  }

  private extractEpisodeLinks(
    container: cheerio.Cheerio<AnyNode>,
    pageUrl: string,
  ): Array<{ href: string; text: string }> {
    const links: Array<{ href: string; text: string }> = [];
    const seen = new Set<string>();

    container.find("a[href]").each((_, element) => {
      const anchor = container.find(element);
      if (
        anchor.closest(
          "nav, header, footer, aside, .sidebar, .menu, .navigation, .related, .recommend, .social, .advert, .ads",
        ).length
      ) {
        return;
      }

      const rawHref = anchor.attr("href");
      if (!rawHref) return;
      const href = normalizeUrl(rawHref, pageUrl);
      const text = anchor.text().replace(/\s+/g, " ").trim();
      const combined = `${text} ${href}`;
      if (!this.isEpisodeLink(combined, text)) return;

      const seasonMatch = combined.match(
        /\b(?:s|season)[\s._-]*0*(\d{1,2})\b/i,
      );
      if (
        seasonMatch &&
        this.intent.requestedSeason &&
        parseInt(seasonMatch[1], 10) !==
          parseInt(this.intent.requestedSeason, 10)
      ) {
        return;
      }

      if (!seen.has(href)) {
        seen.add(href);
        links.push({ href, text });
      }
    });

    return links;
  }

  private isEpisodeLink(combined: string, text: string): boolean {
    if (
      /(?:\bs\d{1,2}\s*e\d{1,3}\b|\b(?:episode|ep)\s*[-._#]?\s*\d{1,3}\b)/i.test(
        combined,
      )
    ) {
      return true;
    }

    return (
      /^\s*(?:episode\s*)?\d{1,3}\s*$/.test(text) &&
      /(?:\bseason\s*\d+\b|\bs\d{1,2}\b)/i.test(combined)
    );
  }

  private async extractResourcesFromPage(
    page: PageContext,
    htmlOverride?: string,
  ): Promise<DiscoveredFile[]> {
    try {
      const htmlToParse = htmlOverride || page.rawHtml || page.bodyText || "";
      const $ = cheerio.load(htmlToParse);
      const resources: DiscoveredFile[] = [];

      const episodeLinks = this.extractSeasonEpisodeLinks($, page.url);
      if (episodeLinks.length > 0) {
        this.log("EXTRACT", `season_episode_links=${episodeLinks.length}`);
        return episodeLinks;
      }

      const mediaResources = await discovery.findDownloadableResources(
        $,
        page.url,
      );
      const videoSources = extractors.extractVideoSources($, page.url);
      const audioSources = extractors.extractAudioSources($, page.url);
      const downloadLinks = extractors.extractDownloadLinks($, page.url);

      resources.push(
        ...mediaResources,
        ...videoSources,
        ...audioSources,
        ...downloadLinks,
      );

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

        const isPack =
          detectSeasonPack(resource.name) || detectSeasonPack(resource.url);
        if (isPack) {
          resource.isSeasonPack = true;
          const range = extractEpisodeRangeFromText(
            `${resource.name} ${resource.url}`,
          );
          if (range) {
            resource.episodeRange = `${range.start}-${range.end}`;
          }
          this.log(
            "EXTRACT",
            `season_pack_detected url=${resource.url} range=${resource.episodeRange || "unknown"}`,
          );
        }

        filtered.push(resource);
      }

      return filtered;
    } catch (e) {
      this.log(
        "EXTRACT",
        `error: ${e instanceof Error ? e.message : "unknown"}`,
        { url: page.url },
      );
      return [];
    }
  }

  private extractSeasonEpisodeLinks(
    $: cheerio.CheerioAPI,
    sourceUrl: string,
  ): DiscoveredFile[] {
    const targetSeason = this.intent.requestedSeason
      ? parseInt(this.intent.requestedSeason, 10)
      : null;
    const targetTitle = (
      this.intent.requestedTitle ||
      this.intent.derivedTitle ||
      ""
    ).toLowerCase();

    const episodeContainers = [
      ".episode-list", ".episodes", ".season-episodes",
      ".entry-content", ".post-content", ".article-content",
      '[class*="episode"]', '[class*="season"]',
      "main", "article", '[role="main"]',
    ];

    let bestContainer: cheerio.Cheerio<AnyNode> | null = null;
    let bestScore = 0;

    for (const selector of episodeContainers) {
      $(selector).each((_, el) => {
        const container = $(el);
        const links = this.extractEpisodeLinks(container, sourceUrl);
        if (links.length < 2) return;

        const containerText = container.text().toLowerCase();
        let score = links.length * 10;

        if (targetSeason) {
          const seasonPattern = new RegExp(
            `(?:season|s)\\s*0*${targetSeason}\\b`,
            "i",
          );
          if (seasonPattern.test(containerText)) score += 50;
        }

        if (targetTitle) {
          const titleTokens = targetTitle.split(/\s+/).filter((t) => t.length > 2);
          const titleMatches = titleTokens.filter((t) => containerText.includes(t)).length;
          score += titleMatches * 5;
        }

        if (score > bestScore) {
          bestScore = score;
          bestContainer = container;
        }
      });
    }

    if (!bestContainer) return [];

    const episodeLinks = this.extractEpisodeLinks(bestContainer, sourceUrl);
    const results: DiscoveredFile[] = [];

    for (const link of episodeLinks) {
      const combined = `${link.href} ${link.text}`.toLowerCase();
      let season: number | undefined;
      let episode: number | undefined;

      const sEMatch = combined.match(/\bs(\d{1,2})e(\d{1,3})\b/i);
      if (sEMatch) {
        season = parseInt(sEMatch[1], 10);
        episode = parseInt(sEMatch[2], 10);
      } else {
        const epMatch = combined.match(/\b(?:episode|ep)[\s._-]*(\d{1,3})\b/i);
        if (epMatch) {
          episode = parseInt(epMatch[1], 10);
          const sMatch = combined.match(/\b(?:season|s)[\s._-]*(\d{1,2})\b/i);
          if (sMatch) season = parseInt(sMatch[1], 10);
        }
      }

      if (targetSeason !== null && season !== undefined && season !== targetSeason) {
        this.log("EXTRACT", `season_mismatch_excluded url=${link.href} season=${season}`);
        continue;
      }

      if (targetSeason !== null && season === undefined && episode === undefined) {
        this.log("EXTRACT", `no_season_info_excluded url=${link.href}`);
        continue;
      }

      results.push({
        url: link.href,
        resourceId: normalizeUrl(link.href),
        name: link.text || link.href,
        quality: undefined,
        parsedTitle: undefined,
        season,
        episode,
        extension: undefined,
        collectionScope: "in_scope" as const,
        fileType: "other" as const,
        mimeType: "application/octet-stream",
        size: undefined,
        downloadable: true,
        sourcePage: sourceUrl,
        resolveStatus: "ready_to_resolve" as const,
      });
    }

    return results;
  }

  private buildPageContext(
    $: cheerio.CheerioAPI,
    url: string,
    rawHtml: string,
  ): PageContext {
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
    $(
      'nav[aria-label*="breadcrumb"] a, .breadcrumb a, [itemtype*="BreadcrumbList"] a',
    ).each((_, el) => {
      const text = $(el).text().trim();
      if (text) breadcrumbs.push(text);
    });

    const links: Array<{ href: string; text: string }> = [];
    const seen = new Set<string>();
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      if (
        href.startsWith("#") ||
        href.startsWith("javascript:") ||
        href.startsWith("mailto:")
      )
        return;
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

  private async fetchAndParsePage(
    url: string,
    _depth?: number,
  ): Promise<PageContext | null> {
    void _depth;
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
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!response.ok) {
        this.failed.add(url);
        return null;
      }

      const contentType = response.headers.get("content-type") || "";
      if (
        !contentType.includes("text/html") &&
        !contentType.includes("application/xhtml+xml")
      ) {
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
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
      });

      clearTimeout(timeout);

      diagnostics.httpStatus = response.status;
      diagnostics.finalUrl = response.url || url;
      diagnostics.contentType = response.headers.get("content-type");
      diagnostics.contentLength =
        parseInt(response.headers.get("content-length") || "0") || null;

      response.headers.forEach((value, key) => {
        if (
          ["server", "x-powered-by", "x-cache", "cf-ray"].includes(
            key.toLowerCase(),
          )
        ) {
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
      } else if (
        msg.includes("tls") ||
        msg.includes("ssl") ||
        msg.includes("certificate")
      ) {
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

  private mapAccessToAnalysis(access: AccessStatus): {
    status: AnalysisStatus;
    message: string;
  } {
    switch (access) {
      case "BLOCKED_403":
        return {
          status: "PROTECTED",
          message:
            "Bulk-D reached this domain, but the server refused the analysis request (HTTP 403). This usually means the site requires a browser session or has automated-access restrictions. Files could not be inspected because the website blocked access.",
        };
      case "UNAUTHORIZED_401":
        return {
          status: "AUTH_REQUIRED",
          message:
            "This page requires authentication. Bulk-D cannot access protected content without user credentials.",
        };
      case "RATE_LIMITED_429":
        return {
          status: "RATE_LIMITED",
          message:
            "The website is rate limiting requests. Bulk-D will not repeatedly retry to avoid further restrictions.",
        };
      case "NOT_FOUND_404":
        return {
          status: "NOT_FOUND",
          message: "The requested page does not exist or has been removed.",
        };
      case "SERVER_ERROR_5XX":
        return {
          status: "SERVER_ERROR",
          message: "The source website returned a server error.",
        };
      case "DNS_ERROR":
        return {
          status: "BLOCKED",
          message: "The domain could not be resolved. Please check the URL.",
        };
      case "TLS_ERROR":
        return {
          status: "BLOCKED",
          message: "A secure HTTPS connection could not be established.",
        };
      case "TIMEOUT":
        return {
          status: "BLOCKED",
          message: "The source did not respond within the configured timeout.",
        };
      default:
        return {
          status: "BLOCKED",
          message: "Bulk-D could not access this URL.",
        };
    }
  }

  private detectSiteWideIndex(page: PageContext): boolean {
    const targetTitle = (
      this.intent.requestedTitle ||
      this.intent.derivedTitle ||
      ""
    ).toLowerCase();
    const targetTokens = targetTitle
      ? new Set(targetTitle.split(/\s+/).filter((w) => w.length > 3))
      : new Set<string>();

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
      this.log(
        "CLASSIFICATION",
        `site_wide_index detected: ${distinctTitles.size} distinct titles on one page`,
        {
          sample: Array.from(distinctTitles.keys()).slice(0, 5),
        },
      );
      return true;
    }

    return false;
  }

  private deduplicateResources(resources: DiscoveredFile[]): DiscoveredFile[] {
    const seen = new Map<string, DiscoveredFile>();
    for (const resource of resources) {
      const key = this.buildDedupeKey(resource);
      const existing = seen.get(key);
      if (
        !existing ||
        this.resourceCompletenessScore(resource) >
          this.resourceCompletenessScore(existing)
      ) {
        seen.set(key, resource);
      }
    }
    return Array.from(seen.values());
  }

  private async resolveAllInParallel(
    resources: DiscoveredFile[],
    concurrency: number
  ): Promise<Array<{ status: "fulfilled"; value: { url: string; filename?: string; size?: number; mimeType?: string } | null } | { status: "rejected"; reason: unknown }>> {
    const results: Array<{ status: "fulfilled"; value: { url: string; filename?: string; size?: number; mimeType?: string } | null } | { status: "rejected"; reason: unknown }> = [];
    const executing = new Set<Promise<void>>();
    let index = 0;

    while (index < resources.length || executing.size > 0) {
      while (executing.size < concurrency && index < resources.length) {
        const i = index++;
        const resource = resources[i];
        const p = (async () => {
          try {
            const jobId = `resolve-${this.jobId}-${i}`;
            const staticResult = await resolveStatic(resource.url, jobId);
            if (staticResult) {
              results[i] = {
                status: "fulfilled",
                value: {
                  url: staticResult.url,
                  filename: staticResult.filename,
                  size: staticResult.size,
                  mimeType: staticResult.mimeType,
                },
              };
              return;
            }

            const hostResult = await resolveHostLink(
              {
                landingUrl: resource.url,
                filename: resource.name || null,
                fileSize: null,
                confidence: 0.5,
                sourcePage: resource.sourcePage || resource.url,
              },
              jobId
            );

            if (hostResult.success) {
              results[i] = {
                status: "fulfilled",
                value: {
                  url: hostResult.finalUrl,
                  filename: hostResult.filename,
                  size: hostResult.contentLength,
                  mimeType: hostResult.contentType,
                },
              };
            } else {
              results[i] = { status: "fulfilled", value: null };
            }
          } catch (e) {
            results[i] = { status: "rejected", reason: e };
          }
        })();
        executing.add(p);
        p.finally(() => executing.delete(p));
      }
      if (executing.size > 0) {
        await Promise.race(executing);
      }
    }

    return results;
  }

  private async validateResources(
    resources: DiscoveredFile[],
  ): Promise<DiscoveredFile[]> {
    const validated: DiscoveredFile[] = [];

    for (const resource of resources) {
      const validation = await resourceValidator.validateResource(resource);
      validated.push({
        ...resource,
        downloadable: validation.downloadable,
        downloadBlocked: validation.reason,
        errorState: validation.errorState,
        quality:
          resource.quality ||
          this.guessQualityFromUrl(`${resource.name} ${resource.url}`),
        resolveStatus: validation.resolveStatus || resource.resolveStatus,
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
    if (qualitySet.size === 0) return ["Default"];
    return Array.from(qualitySet).sort((a, b) => {
      const numA = parseInt(a) || 0;
      const numB = parseInt(b) || 0;
      return numA - numB;
    });
  }

  private applyCollectionScope(resources: DiscoveredFile[]): DiscoveredFile[] {
    const targetTitle = this.normalizeComparableTitle(
      this.intent.requestedTitle || this.intent.derivedTitle || "",
    );
    const targetSeason = this.intent.requestedSeason
      ? parseInt(this.intent.requestedSeason, 10)
      : null;
    const scoped: DiscoveredFile[] = [];
    let outOfScope = 0;

    for (const resource of resources) {
      const parsed = this.parseResourceMetadata(resource);
      const enriched: DiscoveredFile = {
        ...resource,
        resourceId: resource.resourceId || normalizeUrl(resource.url),
        parsedTitle: parsed.title || resource.parsedTitle,
        season: parsed.season ?? resource.season,
        episode: parsed.episode ?? resource.episode,
        quality: resource.quality || parsed.quality,
        extension: parsed.extension || resource.extension,
      };

      const inScope = this.isInCollectionScope(
        enriched,
        targetTitle,
        targetSeason,
      );
      enriched.collectionScope = inScope ? "in_scope" : "out_of_scope";

      if (inScope) {
        scoped.push(enriched);
      } else {
        outOfScope++;
      }
    }

    if (outOfScope > 0) {
      this.log(
        "COLLECTION_SCOPE",
        `in_scope=${scoped.length} out_of_scope=${outOfScope}`,
        {
          targetTitle,
          targetSeason,
        },
      );
    }

    return scoped;
  }

  private parseResourceMetadata(resource: DiscoveredFile): {
    title?: string;
    season?: number;
    episode?: number;
    quality?: Quality;
    extension?: string;
  } {
    const text = `${resource.name} ${resource.url}`;
    const quality = this.guessQualityFromUrl(text);
    const extension =
      this.extractExtension(resource.url) ||
      this.extractExtension(resource.name);
    let title: string | undefined;
    let season: number | undefined;
    let episode: number | undefined;

    const sEMatch =
      text.match(/\bS(\d{1,2})E(\d{1,3})\b/i) ||
      text.match(/\bSeason[\s._-]*(\d{1,2})[\s._-]*(?:Episode|Ep)[\s._-]*(\d{1,3})\b/i);
    if (sEMatch) {
      season = parseInt(sEMatch[1], 10);
      episode = parseInt(sEMatch[2], 10);
      const idx = Math.max(0, text.search(sEMatch[0]));
      const beforeEpisode = text.slice(0, idx);
      const cleaned = beforeEpisode
        .replace(/^https?:\/\/[^/]+\//i, "")
        .split(/[/?#]/)
        .pop()
        ?.replace(/\.[^.]+$/i, "")
        .replace(/[._-]+/g, " ")
        .trim();
      title = cleaned || undefined;
    } else {
      const epMatch = text.match(/\b(?:episode|ep)[\s._-]*(\d{1,3})\b/i);
      if (epMatch) {
        episode = parseInt(epMatch[1], 10);
        const sMatch = text.match(/\b(?:season|s)[\s._-]*(\d{1,2})\b/i);
        if (sMatch) season = parseInt(sMatch[1], 10);
        const idx = Math.max(0, text.search(epMatch[0]));
        const beforeEpisode = text.slice(0, idx);
        const cleaned = beforeEpisode
          .replace(/^https?:\/\/[^/]+\//i, "")
          .split(/[/?#]/)
          .pop()
          ?.replace(/\.[^.]+$/i, "")
          .replace(/[._-]+/g, " ")
          .trim();
        title = cleaned || undefined;
      } else if (resource.isSeasonPack) {
        const seasonMatch = text.match(/\bS(?:eason)?[\s._-]*(\d{1,2})\b/i);
        if (seasonMatch) season = parseInt(seasonMatch[1], 10);
      } else {
        const urlPathMatch = resource.url.match(
          /(?:season|s)[\s._-]*(\d{1,2})[\s._-]*(?:episode|ep)[\s._-]*(\d{1,3})/i,
        );
        if (urlPathMatch) {
          season = parseInt(urlPathMatch[1], 10);
          episode = parseInt(urlPathMatch[2], 10);
        } else {
          const seasonOnly = resource.url.match(
            /(?:season|s)[\s._-]*(\d{1,2})/i,
          );
          if (seasonOnly) season = parseInt(seasonOnly[1], 10);
        }
      }
    }

    if (season === undefined && resource.sourcePage) {
      const sourceSeason = resource.sourcePage.match(
        /(?:season|s)[\s._-]*(\d{1,2})/i,
      );
      if (sourceSeason) season = parseInt(sourceSeason[1], 10);
    }

    return { title, season, episode, quality, extension };
  }

  private isInCollectionScope(
    resource: DiscoveredFile,
    targetTitle: string,
    targetSeason: number | null,
  ): boolean {
    const resourceTitle = this.normalizeComparableTitle(
      resource.parsedTitle || resource.name || resource.url,
    );
    const combined = `${resource.url} ${resource.name}`.toLowerCase();
    const sourcePageText = (resource.sourcePage || "").toLowerCase();

    const titleTokens = targetTitle
      .split(" ")
      .filter((token) => token.length > 2);

    if (targetTitle) {
      const titleMatches =
        titleTokens.length === 0 ||
        titleTokens.every(
          (token) =>
            resourceTitle.includes(token) ||
            combined.includes(token) ||
            sourcePageText.includes(token),
        );
      if (!titleMatches) return false;
    }

    if (targetSeason !== null && Number.isFinite(targetSeason)) {
      if (resource.season !== undefined)
        return resource.season === targetSeason;
      if (resource.isSeasonPack) {
        const seasonPattern = new RegExp(
          `\\b(?:s0*${targetSeason}|season[\\s._-]*${targetSeason})\\b`,
          "i",
        );
        return seasonPattern.test(combined);
      }
      if (titleTokens.length > 0 && titleTokens.every(
        (token: string) =>
          resourceTitle.includes(token) ||
          combined.includes(token) ||
          sourcePageText.includes(token),
      )) {
        return true;
      }
      return false;
    }

    return true;
  }

  private buildDedupeKey(resource: DiscoveredFile): string {
    let title = resource.parsedTitle;
    let season = resource.season;
    let episode = resource.episode;

    if (!title || season === undefined || episode === undefined) {
      const parsed = this.parseResourceMetadata(resource);
      if (!title && parsed.title) title = parsed.title;
      if (season === undefined && parsed.season !== undefined) season = parsed.season;
      if (episode === undefined && parsed.episode !== undefined) episode = parsed.episode;
    }

    if (title && season !== undefined && episode !== undefined) {
      const normalizedTitle = this.normalizeComparableTitle(title);
      const quality = resource.quality || "Default";
      const extension =
        resource.extension || this.extractExtension(resource.url) || "";
      return `${normalizedTitle}:S${season}:E${episode}:${quality}:${extension}`;
    }
    return normalizeUrl(resource.url);
  }

  private resourceCompletenessScore(resource: DiscoveredFile): number {
    return [
      resource.name,
      resource.quality,
      resource.size,
      resource.mimeType && resource.mimeType !== "application/octet-stream"
        ? resource.mimeType
        : null,
      resource.sourcePage,
      resource.resolveStatus,
    ].filter(Boolean).length;
  }

  private normalizeComparableTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(
        /\b(season|complete|download|episode|episodes|ep|full|pack|batch)\b/g,
        " ",
      )
      .replace(/\bs\d{1,2}e\d{1,3}\b/g, " ")
      .replace(/\bs\d{1,2}\b/g, " ")
      .replace(/\b\d{3,4}p\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  private extractExtension(value: string): string | undefined {
    const match = value.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
    return match ? match[1].toLowerCase() : undefined;
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
      crawl: {
        pagesDiscovered: 0,
        pagesVisited: 0,
        pagesBlocked: 0,
        pagesFailed: 0,
      },
      files: [],
      statistics: {
        discovered: 0,
        downloadable: 0,
        inaccessible: 0,
        unsupported: 0,
        totalSize: 0,
      },
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
