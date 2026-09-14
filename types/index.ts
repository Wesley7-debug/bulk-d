export type JobStatus =
  | "analyzing"
  | "discovered"
  | "ready"
  | "queued"
  | "downloading"
  | "packaging"
  | "completed"
  | "failed"
  | "partial"
  | "cancelled";

export type Quality = string;

export type FileType = "video" | "audio" | "image" | "document" | "archive" | "other";

export type AccessStatus =
  | "ACCESSIBLE"
  | "BLOCKED_403"
  | "UNAUTHORIZED_401"
  | "RATE_LIMITED_429"
  | "NOT_FOUND_404"
  | "SERVER_ERROR_5XX"
  | "REDIRECT_ERROR"
  | "TIMEOUT"
  | "DNS_ERROR"
  | "TLS_ERROR"
  | "ROBOTS_RESTRICTED"
  | "AUTHENTICATION_REQUIRED"
  | "UNKNOWN";

export type AnalysisStatus =
  | "ANALYZING"
  | "ACCESSIBLE"
  | "PROTECTED"
  | "BLOCKED"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "SERVER_ERROR"
  | "NO_MEDIA_FOUND"
  | "MEDIA_FOUND"
  | "PARTIAL"
  | "COMPLETED";

export type ErrorState =
  | "ACCESS_BLOCKED"
  | "NOT_DOWNLOADABLE"
  | "AUTHENTICATION_REQUIRED"
  | "RATE_LIMITED"
  | "INVALID_URL"
  | "NO_MEDIA_FOUND"
  | "CRAWL_LIMIT_REACHED"
  | "TIMEOUT"
  | "SERVER_ERROR"
  | "UNKNOWN";

export type CrawlPageType =
  | "home"
  | "listing"
  | "detail"
  | "category"
  | "tag"
  | "search"
  | "pagination"
  | "resource"
  | "unknown";

export type PageClassification =
  | "CONTENT_INDEX"
  | "CONTENT_PAGE"
  | "HOST_LANDING_PAGE"
  | "DIRECT_RESOURCE";

export type DiscoveryMethod =
  | "meta-tags"
  | "json-ld"
  | "download-attribute"
  | "media-elements"
  | "media-links"
  | "download-button"
  | "anchor-links"
  | "iframe-src"
  | "script-injected"
  | "api-endpoint"
  | "data-uri"
  | "source-element"
  | "object-embed";

export interface DiscoveredFile {
  url: string;
  resourceId?: string;
  name: string;
  quality?: Quality;
  parsedTitle?: string;
  season?: number;
  episode?: number;
  extension?: string;
  collectionScope?: "in_scope" | "out_of_scope";
  fileType: FileType;
  mimeType: string;
  size?: number;
  downloadable: boolean;
  downloadBlocked?: string;
  errorState?: ErrorState;
  thumbnailUrl?: string;
  duration?: string;
  discoveryMethod?: DiscoveryMethod;
  sourcePage?: string;
  contentDisposition?: string;
  isSeasonPack?: boolean;
  episodeRange?: string;
  resolvedUrl?: string;
  resolveStatus?: "ready_to_resolve" | "resolving" | "resolved" | "resolution_failed" | "requires_login";
}

export interface CollectionResult {
  title: string;
  thumbnailUrl?: string;
  sourceUrl: string;
  files: DiscoveredFile[];
  qualities: Quality[];
  totalSize?: number;
  metadata?: Record<string, string>;
  collectionName?: string;
  description?: string;
}

export interface CrawlStats {
  pagesDiscovered: number;
  pagesVisited: number;
  pagesBlocked: number;
  pagesFailed: number;
}

export interface FileStats {
  discovered: number;
  downloadable: number;
  inaccessible: number;
  unsupported: number;
  totalSize: number;
}

export interface AccessDiagnostics {
  accessStatus: AccessStatus;
  httpStatus: number | null;
  finalUrl: string;
  contentType: string | null;
  contentLength: number | null;
  redirectCount: number;
  robotsStatus: string | null;
  serverHeaders: Record<string, string>;
  tlsValid: boolean;
  dnsResolved: boolean;
  crawlStarted: boolean;
}

export interface AnalysisWarning {
  code: string;
  message: string;
}

export interface AnalysisResult {
  jobId: string;
  status: AnalysisStatus;
  accessStatus: AccessStatus;
  domain: string;
  originalUrl: string;
  finalUrl: string;
  title: string | null;
  description: string | null;
  thumbnail: string | null;
  crawl: CrawlStats;
  files: DiscoveredFile[];
  statistics: FileStats;
  availableQualities: Quality[];
  message: string;
  details: AccessDiagnostics;
  warnings: AnalysisWarning[];
}

export interface DownloadTaskData {
  jobId: string;
  fileId: string;
  url: string;
  fileName: string;
  quality: Quality;
  userId?: string;
}

export interface JobProgress {
  jobId: string;
  status: JobStatus;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  totalBytes: number;
  downloadedBytes: number;
  currentFile?: string;
  zipUrl?: string;
  zipSize?: number;
  error?: string;
}

export interface AnalyzeRequest {
  url?: string;
  search?: string;
}

export interface CreateJobRequest {
  sourceUrl: string;
  collectionTitle: string;
  quality: Quality;
  fileUrls: string[];
  thumbnailUrl?: string;
}

export interface SourceAdapter {
  name: string;
  canHandle(url: string): boolean;
  discover(url: string): Promise<DiscoveredResource[]>;
  analyze(url: string): Promise<CollectionResult>;
}

export interface DiscoveredResource {
  url: string;
  name: string;
  quality?: Quality;
  season?: number;
  episode?: number;
  size?: number;
  fileType: FileType;
  sourcePage?: string;
}

export interface CrawlPage {
  url: string;
  depth: number;
  html?: string;
  title?: string;
  links: string[];
  resources: DiscoveredFile[];
  metadata: Record<string, string>;
}

export interface CrawlResult {
  entryUrl: string;
  domain: string;
  pagesVisited: number;
  pages: CrawlPage[];
  allResources: DiscoveredFile[];
  collection: CollectionResult;
}

export interface SearchResult {
  title: string;
  url: string;
  domain: string;
  description: string;
  thumbnailUrl?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  totalResults: number;
}

export interface SiteDiscoveryResult {
  relatedUrls: string[];
  paginationUrls: string[];
  seriesUrls: string[];
  title?: string;
  description?: string;
  metadata: Record<string, string>;
}

export interface UserIntent {
  query: string | null;
  sourceUrl: string;
  requestedTitle: string | null;
  requestedSeason: string | null;
  requestedEpisodeRange: string | null;
  requestedQuality: string | null;
  derivedTitle: string | null;
}

export interface AIPageAnalysis {
  pageType: "detail" | "collection" | "tag" | "category" | "episode" | "resource" | "unknown";
  target: {
    title: string | null;
    season: number | null;
    episodeRange: [number, number] | null;
  };
  relevantLinks: AIlinkRank[];
  irrelevantLinks: AIlinkRank[];
  collectionName: string | null;
  description: string | null;
  confidence: number;
}

export interface AIlinkRank {
  url: string;
  reason: string;
  confidence: number;
}

export interface RelevanceScore {
  url: string;
  total: number;
  semantic: number;
  titleMatch: number;
  seasonMatch: number;
  anchorMatch: number;
  structural: number;
  decision: "QUEUE" | "SKIP" | "EXTRACT";
  reason: string;
}

export interface PageContext {
  url: string;
  title: string | null;
  metaDescription: string | null;
  headings: string[];
  breadcrumbs: string[];
  links: Array<{ href: string; text: string }>;
  structuredData: Record<string, unknown>[];
  bodyText: string;
  rawHtml: string;
  metadata: Record<string, string>;
  pageType?: CrawlPageType;
}

export interface PageClassificationResult {
  classification: PageClassification;
  confidence: number;
  reasons: string[];
  scores: Record<PageClassification, number>;
}

export interface HostLink {
  landingUrl: string;
  filename: string | null;
  fileSize: string | null;
  confidence: number;
  sourcePage: string;
}

export interface MediaResource {
  url: string;
  filename: string;
  fileType: FileType;
  mimeType: string;
  size?: number;
  requestHeaders?: Record<string, string>;
  resolutionStrategy: "static" | "adapter" | "headless" | "manual";
  resolutionLog: string[];
}

export type HostLinkResolveResult =
  | {
      success: true;
      finalUrl: string;
      contentType: string;
      contentLength?: number;
      filename?: string;
      fileType: FileType;
      requestHeaders?: Record<string, string>;
      resolutionStrategy: "static" | "adapter" | "headless" | "manual";
      resolutionLog: string[];
    }
  | {
      success: false;
      reason: string;
      resolutionLog?: string[];
    };

export type ResolutionJobStatus = "queued" | "analyzing" | "resolving" | "completed" | "failed" | "ready";

export type EpisodeResolveStatus = "queued" | "resolving" | "resolved" | "failed";

export interface EpisodeState {
  name: string;
  url: string;
  status: EpisodeResolveStatus;
  resolvedUrl?: string;
  error?: string;
}

export interface ResolutionJob {
  jobId: string;
  originalUrl: string;
  status: ResolutionJobStatus;
  total: number;
  current: number;
  episodes: EpisodeState[];
  result: AnalysisResult | null;
  createdAt: number;
}

export interface SpeedTestSite {
  name: string;
  status: "pending" | "resolving" | "resolved" | "failed";
  responseTimeMs?: number;
  url?: string;
}

export interface ResolutionProgressEvent {
  type: "phase" | "episode_start" | "episode_complete" | "speed_test" | "result" | "error";
  jobId: string;
  phase?: ResolutionJobStatus;
  message?: string;
  current?: number;
  total?: number;
  episodeName?: string;
  episodeStatus?: EpisodeResolveStatus;
  resolvedUrl?: string;
  error?: string;
  speedTest?: {
    status: "testing" | "winner";
    sites?: SpeedTestSite[];
    winner?: { name: string; url: string; responseTimeMs: number };
  };
  result?: AnalysisResult;
}

export interface CrawlEvent {
  type: "crawl_started" | "crawl_progress" | "crawl_complete" | "crawl_failed";
  jobId: string;
  total?: number;
  current?: number;
  message?: string;
  crawlResult?: AnalysisResult;
}

export interface ResolutionEvent {
  type: "resolution_started" | "episode_resolving" | "episode_resolved" | "episode_failed" | "resolution_complete";
  jobId: string;
  index?: number;
  total?: number;
  episode?: string;
  episodeId?: string;
  downloadUrl?: string;
  filename?: string;
  reason?: string;
  resolved?: number;
  failed?: number;
}
