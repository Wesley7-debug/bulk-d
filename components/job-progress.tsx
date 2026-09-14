"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Progress } from "./ui/progress";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { formatBytes, getProgressPercent } from "../lib/utils";

interface FileDetail {
  fileName: string;
  url: string;
  downloaded: boolean;
  failed: boolean;
  error: string | null;
  quality: string;
  resolving?: boolean;
  resolvedUrl?: string | null;
  resolutionStrategy?: string | null;
}

interface JobProgress {
  jobId: string;
  status: string;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  totalBytes: number;
  downloadedBytes: number;
  zipUrl?: string;
  zipSize?: number;
  error?: string;
  files?: FileDetail[];
  failedFileDetails?: FileDetail[];
  succeededFileDetails?: FileDetail[];
  resolvingFileDetails?: FileDetail[];
}

const statusColors: Record<string, string> = {
  analyzing: "text-blue-400",
  queued: "text-yellow-400",
  downloading: "text-blue-400",
  packaging: "text-purple-400",
  completed: "text-green-400",
  failed: "text-red-400",
  partial: "text-yellow-400",
  cancelled: "text-gray-400",
};

const statusBadges: Record<string, "default" | "success" | "warning" | "destructive"> = {
  analyzing: "default",
  queued: "warning",
  downloading: "default",
  packaging: "default",
  completed: "success",
  failed: "destructive",
  partial: "warning",
  cancelled: "default",
};

export function JobProgress({ jobId }: { jobId: string }) {
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [error, setError] = useState("");

  const fetchProgress = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/progress`);
      if (res.ok) {
        const data = await res.json();
        setProgress(data);
        return true;
      }
    } catch {
      // Will retry
    }
    return false;
  }, [jobId]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    let active = true;

    const poll = async () => {
      if (!active) return;
      const success = await fetchProgress();
      if (success && active) {
        interval = setTimeout(poll, 1000) as unknown as NodeJS.Timeout;
      }
    };

    poll();

    return () => {
      active = false;
      clearTimeout(interval);
    };
  }, [fetchProgress]);

  const handleCancel = async () => {
    try {
      await fetch(`/api/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      fetchProgress();
    } catch {
      setError("Failed to cancel job");
    }
  };

  const handleRetry = async () => {
    try {
      await fetch(`/api/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry" }),
      });
      fetchProgress();
    } catch {
      setError("Failed to retry job");
    }
  };

  const handleDownload = async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/download`);
      const data = await res.json();
      if (res.ok && data.url) {
        window.open(data.url, "_blank");
      } else {
        setError(data.error || "Failed to get download URL");
      }
    } catch {
      setError("Failed to generate download URL");
    }
  };

  if (!progress) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-gray-500">
          Loading job status...
        </CardContent>
      </Card>
    );
  }

  const percent = getProgressPercent(progress.completedFiles, progress.totalFiles);

  const statusMessages: Record<string, string> = {
    analyzing: "Analyzing collection...",
    queued: "Queued for download...",
    downloading: `Downloading ${progress.completedFiles + 1} of ${progress.totalFiles}...`,
    packaging: "Packaging ZIP file...",
    completed: "Download complete!",
    failed: "Job failed",
    partial: `Partially complete (${progress.completedFiles}/${progress.totalFiles})`,
    cancelled: "Job cancelled",
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <span className={statusColors[progress.status] || "text-white"}>
                {progress.status.toUpperCase()}
              </span>
            </CardTitle>
            <Badge variant={statusBadges[progress.status] || "default"}>
              {progress.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-gray-300">
            {statusMessages[progress.status] || progress.status}
          </div>

          <Progress value={percent} />

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Files: </span>
              <span className="text-white">
                {progress.completedFiles} / {progress.totalFiles}
              </span>
              {progress.failedFiles > 0 && (
                <span className="text-red-400"> ({progress.failedFiles} failed)</span>
              )}
            </div>
            <div>
              <span className="text-gray-500">Size: </span>
              <span className="text-white">
                {formatBytes(progress.downloadedBytes)}
                {progress.totalBytes > 0 && ` / ${formatBytes(progress.totalBytes)}`}
              </span>
            </div>
          </div>

          {progress.zipSize && (
            <div className="text-sm">
              <span className="text-gray-500">ZIP Size: </span>
              <span className="text-white">{formatBytes(progress.zipSize)}</span>
            </div>
          )}

          {progress.resolvingFileDetails && progress.resolvingFileDetails.length > 0 && (
            <div className="rounded-lg border border-blue-800/50 bg-blue-900/10 p-3 space-y-2">
              <h4 className="text-xs font-medium text-blue-400">Resolving ({progress.resolvingFileDetails.length})</h4>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {progress.resolvingFileDetails.map((f, i) => (
                  <div key={i} className="text-xs text-blue-300/80">
                    <span className="font-medium">{f.fileName}</span>
                    <span className="text-blue-400/60 ml-1">— resolving host link (may take 20-40s)...</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {progress.failedFileDetails && progress.failedFileDetails.length > 0 && (
            <div className="rounded-lg border border-red-800/50 bg-red-900/10 p-3 space-y-2">
              <h4 className="text-xs font-medium text-red-400">Failed Files ({progress.failedFileDetails.length})</h4>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {progress.failedFileDetails.map((f, i) => (
                  <div key={i} className="text-xs text-red-300/80">
                    <span className="font-medium">{f.fileName}</span>
                    {f.error && <span className="text-red-400/60 ml-1">— {f.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {progress.succeededFileDetails && progress.succeededFileDetails.length > 0 && (
            <div className="rounded-lg border border-green-800/30 bg-green-900/10 p-3 space-y-2">
              <h4 className="text-xs font-medium text-green-400">Downloaded ({progress.succeededFileDetails.length})</h4>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {progress.succeededFileDetails.map((f, i) => (
                  <div key={i} className="text-xs text-green-300/70">
                    {f.fileName}
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-900/30 border border-red-800 p-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            {progress.status === "completed" && (
              <Button onClick={handleDownload} className="flex-1">
                Download ZIP
              </Button>
            )}

            {["failed", "partial"].includes(progress.status) && (
              <Button onClick={handleRetry} variant="outline" className="flex-1">
                Retry Failed
              </Button>
            )}

            {["analyzing", "queued", "downloading", "packaging"].includes(progress.status) && (
              <Button onClick={handleCancel} variant="destructive" className="flex-1">
                Cancel Job
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
