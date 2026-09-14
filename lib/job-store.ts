import { ResolutionJob, EpisodeState, DiscoveredFile, AnalysisResult, CrawlEvent, ResolutionEvent } from "../types";

const JOBS = new Map<string, ResolutionJob>();
const JOB_TTL_MS = 30 * 60 * 1000;

const EVENT_HISTORY = new Map<string, Array<CrawlEvent | ResolutionEvent>>();
const EVENT_LISTENERS = new Map<string, Set<(event: CrawlEvent | ResolutionEvent) => void>>();

function cleanup() {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (now - job.createdAt > JOB_TTL_MS) {
      JOBS.delete(id);
      EVENT_HISTORY.delete(id);
      EVENT_LISTENERS.delete(id);
    }
  }
}

export function createJob(
  jobId: string,
  originalUrl: string,
  files: DiscoveredFile[] = []
): ResolutionJob {
  cleanup();

  const episodes: EpisodeState[] = files
    .filter((f) => f.downloadable)
    .map((f) => ({
      name: f.name || f.url.split("/").pop() || "unknown",
      url: f.url,
      status: "queued" as const,
    }));

  const job: ResolutionJob = {
    jobId,
    originalUrl,
    status: "queued",
    total: episodes.length,
    current: 0,
    episodes,
    result: null,
    createdAt: Date.now(),
  };

  JOBS.set(jobId, job);
  return job;
}

export function getJob(jobId: string): ResolutionJob | null {
  cleanup();
  return JOBS.get(jobId) || null;
}

export function setJobStatus(jobId: string, status: ResolutionJob["status"]): void {
  const job = JOBS.get(jobId);
  if (job) job.status = status;
}

export function setJobEpisodes(jobId: string, files: DiscoveredFile[]): void {
  const job = JOBS.get(jobId);
  if (!job) return;
  job.episodes = files
    .filter((f) => f.downloadable)
    .map((f) => ({
      name: f.name || f.url.split("/").pop() || "unknown",
      url: f.url,
      status: "queued" as const,
    }));
  job.total = job.episodes.length;
  job.current = 0;
}

export function updateEpisode(
  jobId: string,
  index: number,
  update: Partial<EpisodeState>
): void {
  const job = JOBS.get(jobId);
  if (!job || !job.episodes[index]) return;
  Object.assign(job.episodes[index], update);
  if (update.status === "resolved" || update.status === "failed") {
    job.current = job.episodes.filter(
      (e) => e.status === "resolved" || e.status === "failed"
    ).length;
  }
}

export function setJobResult(jobId: string, result: AnalysisResult): void {
  const job = JOBS.get(jobId);
  if (job) {
    job.result = result;
    job.status = "completed";
  }
}

export function setJobError(jobId: string, error: string): void {
  const job = JOBS.get(jobId);
  if (job) {
    job.status = "failed";
    job.result = {
      ...getDefaultResult(jobId, job.originalUrl),
      status: "BLOCKED",
      message: error,
    };
  }
}

export function getJobEpisodes(jobId: string): EpisodeState[] | null {
  const job = JOBS.get(jobId);
  return job ? job.episodes : null;
}

export function setCrawlResult(jobId: string, result: AnalysisResult): void {
  const job = JOBS.get(jobId);
  if (job) {
    job.result = result;
    job.status = "ready";
  }
}

function getDefaultResult(jobId: string, url: string): AnalysisResult {
  return {
    jobId,
    status: "BLOCKED",
    accessStatus: "UNKNOWN",
    domain: "",
    originalUrl: url,
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
      tlsValid: false,
      dnsResolved: false,
      crawlStarted: false,
    },
    warnings: [],
  };
}

export function emitEvent(jobId: string, event: CrawlEvent | ResolutionEvent): void {
  if (!EVENT_HISTORY.has(jobId)) {
    EVENT_HISTORY.set(jobId, []);
  }
  EVENT_HISTORY.get(jobId)!.push(event);

  const listeners = EVENT_LISTENERS.get(jobId);
  if (listeners) {
    for (const listener of listeners) {
      try { listener(event); } catch { /* ignore */ }
    }
  }
}

export function getEventHistory(jobId: string): Array<CrawlEvent | ResolutionEvent> {
  return EVENT_HISTORY.get(jobId) || [];
}

export function subscribeToEvents(
  jobId: string,
  listener: (event: CrawlEvent | ResolutionEvent) => void
): () => void {
  if (!EVENT_LISTENERS.has(jobId)) {
    EVENT_LISTENERS.set(jobId, new Set());
  }
  EVENT_LISTENERS.get(jobId)!.add(listener);

  return () => {
    const listeners = EVENT_LISTENERS.get(jobId);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        EVENT_LISTENERS.delete(jobId);
      }
    }
  };
}

export function getDownloadableFiles(jobId: string): DiscoveredFile[] {
  const job = JOBS.get(jobId);
  if (!job?.result) return [];
  return job.result.files.filter((f) => f.downloadable);
}
