export type PipelineStage =
  | "INPUT"
  | "NORMALIZE"
  | "DNS"
  | "TLS"
  | "ROBOTS"
  | "FETCH"
  | "REDIRECT"
  | "ACCESS_CHECK"
  | "CRAWL"
  | "DISCOVERY"
  | "EXTRACTION"
  | "CLASSIFICATION"
  | "TITLE_FILTER"
  | "HOST_DETECT"
  | "RESOLVE"
  | "VALIDATION"
  | "QUALITY"
  | "COLLECTION"
  | "RESULT";

export interface LogEntry {
  timestamp: string;
  jobId: string;
  stage: PipelineStage | string;
  message: string;
  data?: Record<string, unknown>;
}

class Logger {
  private logs: Map<string, LogEntry[]> = new Map();
  private enabled: boolean = process.env.LOG_VERBOSE === "true";

  private timestamp(): string {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, "0");
    const m = String(now.getMinutes()).padStart(2, "0");
    const s = String(now.getSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  log(jobId: string, stage: PipelineStage | string, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: this.timestamp(),
      jobId,
      stage,
      message,
      data,
    };

    const jobLogs = this.logs.get(jobId) || [];
    jobLogs.push(entry);
    this.logs.set(jobId, jobLogs);

    if (this.enabled) {
      const dataStr = data ? ` ${JSON.stringify(data)}` : "";
      console.log(`[${entry.timestamp}] [${jobId}] ${stage} ${message}${dataStr}`);
    }
  }

  getLogs(jobId: string): LogEntry[] {
    return this.logs.get(jobId) || [];
  }

  clearLogs(jobId: string): void {
    this.logs.delete(jobId);
  }
}

export const logger = new Logger();

export function generateJobId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
