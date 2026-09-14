"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  AnalysisResult,
  AnalysisStatus,
  AccessStatus,
  DiscoveredFile,
  ResolutionEvent,
} from "../types";
import { Button } from "./ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Checkbox } from "./ui/checkbox";
import { formatBytes } from "../lib/utils";
import { Download, Loader2 } from "lucide-react";

function isErrorStatus(status: AnalysisStatus): boolean {
  return ["PROTECTED", "BLOCKED", "AUTH_REQUIRED", "RATE_LIMITED", "NOT_FOUND", "SERVER_ERROR"].includes(status);
}

function getAccessTitle(status: AccessStatus): string {
  switch (status) {
    case "BLOCKED_403": return "Website Access Blocked";
    case "UNAUTHORIZED_401": return "Authentication Required";
    case "RATE_LIMITED_429": return "Rate Limited";
    case "NOT_FOUND_404": return "Page Not Found";
    case "SERVER_ERROR_5XX": return "Server Error";
    case "DNS_ERROR": return "Domain Not Found";
    case "TLS_ERROR": return "Secure Connection Failed";
    case "TIMEOUT": return "Connection Timed Out";
    default: return "Access Issue";
  }
}

function getAccessIcon(status: AccessStatus): string {
  switch (status) {
    case "BLOCKED_403": return "\u2716";
    case "UNAUTHORIZED_401": return "\u{1F512}";
    case "RATE_LIMITED_429": return "\u23F3";
    case "NOT_FOUND_404": return "\u2753";
    case "SERVER_ERROR_5XX": return "\u26A0";
    case "DNS_ERROR": return "\u2601";
    case "TLS_ERROR": return "\u{1F512}";
    case "TIMEOUT": return "\u23F0";
    default: return "\u2753";
  }
}

function deriveQualities(files: DiscoveredFile[]): string[] {
  const qualitySet = new Set<string>();
  for (const f of files) {
    if (f.quality && f.quality.trim()) {
      qualitySet.add(f.quality.trim());
    }
  }
  return Array.from(qualitySet).sort((a, b) => {
    const numA = parseInt(a.replace(/\D/g, "")) || 0;
    const numB = parseInt(b.replace(/\D/g, "")) || 0;
    return numA - numB;
  });
}

function getDisplayName(file: DiscoveredFile, index: number): string {
  if (file.name && file.name !== "download" && file.name.trim().length > 0) {
    return file.name;
  }
  try {
    const url = new URL(file.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && last !== "download.php" && last.length > 3) {
      return decodeURIComponent(last);
    }
  } catch {}
  if (file.season && file.episode) {
    return `Season ${file.season}, Episode ${file.episode}`;
  }
  return `File ${index + 1}`;
}

function getFileId(file: DiscoveredFile): string {
  return file.resourceId || file.url;
}

function triggerBrowserDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function proxyDownload(file: DiscoveredFile): Promise<void> {
  const response = await fetch("/api/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      files: [{
        id: getFileId(file),
        url: file.url,
        resolvedUrl: file.resolvedUrl || file.url,
        filename: getDisplayName(file, 0),
      }],
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Download failed" }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = getDisplayName(file, 0);
  a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);
}

function deduplicateFiles(files: DiscoveredFile[]): DiscoveredFile[] {
  const seen = new Map<string, DiscoveredFile>();
  for (const file of files) {
    const id = getFileId(file);
    const existing = seen.get(id);
    if (!existing) {
      seen.set(id, file);
      continue;
    }
    const existingScore = [
      existing.resolvedUrl,
      existing.name,
      existing.quality,
      existing.size,
      existing.season,
      existing.episode,
    ].filter(Boolean).length;
    const currentScore = [
      file.resolvedUrl,
      file.name,
      file.quality,
      file.size,
      file.season,
      file.episode,
    ].filter(Boolean).length;
    if (currentScore > existingScore) {
      seen.set(id, file);
    }
  }
  return Array.from(seen.values());
}

interface EpisodeState {
  status: "queued" | "resolving" | "resolved" | "failed";
  downloadUrl?: string;
  filename?: string;
  error?: string;
}

function ErrorStateDisplay({ analysis }: { analysis: AnalysisResult }) {
  const router = useRouter();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-900/30 text-2xl">
              {getAccessIcon(analysis.accessStatus)}
            </div>
            <div className="space-y-1">
              <CardTitle className="text-xl text-red-400">
                {getAccessTitle(analysis.accessStatus)}
              </CardTitle>
              <p className="text-sm text-gray-400">{analysis.domain}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-300 leading-relaxed">
            {analysis.message}
          </p>

          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 space-y-3">
            <h3 className="text-sm font-medium text-gray-300">Diagnostics</h3>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className={analysis.details.dnsResolved ? "text-green-400" : "text-red-400"}>
                  {analysis.details.dnsResolved ? "\u2713" : "\u2716"}
                </span>
                <span className="text-gray-400">DNS Resolution</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={analysis.details.tlsValid ? "text-green-400" : "text-red-400"}>
                  {analysis.details.tlsValid ? "\u2713" : "\u2716"}
                </span>
                <span className="text-gray-400">HTTPS Connection</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={analysis.details.httpStatus && analysis.details.httpStatus < 400 ? "text-green-400" : "text-red-400"}>
                  {analysis.details.httpStatus && analysis.details.httpStatus < 400 ? "\u2713" : "\u2716"}
                </span>
                <span className="text-gray-400">
                  HTTP {analysis.details.httpStatus || "N/A"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className={analysis.details.crawlStarted ? "text-green-400" : "text-red-400"}>
                  {analysis.details.crawlStarted ? "\u2713" : "\u2716"}
                </span>
                <span className="text-gray-400">Page Content Inspected</span>
              </div>
            </div>

            {analysis.details.finalUrl && analysis.details.finalUrl !== analysis.originalUrl && (
              <div className="text-xs text-gray-500">
                <span className="text-gray-400">Final URL: </span>
                <span className="break-all">{analysis.details.finalUrl}</span>
              </div>
            )}

            {analysis.details.robotsStatus && (
              <div className="text-xs text-gray-500">
                <span className="text-gray-400">robots.txt: </span>
                <span>Status {analysis.details.robotsStatus}</span>
              </div>
            )}

            {Object.keys(analysis.details.serverHeaders).length > 0 && (
              <div className="text-xs text-gray-500">
                <span className="text-gray-400">Server: </span>
                <span>{analysis.details.serverHeaders["server"] || "Unknown"}</span>
              </div>
            )}
          </div>

          {analysis.warnings.length > 0 && (
            <div className="rounded-lg border border-yellow-900/50 bg-yellow-900/10 p-3">
              <h4 className="text-xs font-medium text-yellow-400 mb-2">Warnings</h4>
              {analysis.warnings.map((w, i) => (
                <p key={i} className="text-xs text-yellow-300/70">{w.message}</p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Button
        onClick={() => router.push("/")}
        variant="outline"
        className="w-full"
        size="lg"
      >
        Try Another URL
      </Button>
    </div>
  );
}

function SuccessStateDisplay({ analysis, jobId }: { analysis: AnalysisResult; jobId: string | null }) {
  const dedupedFiles = useMemo(() => deduplicateFiles(analysis.files), [analysis.files]);
  const derivedQualities = useMemo(() => deriveQualities(dedupedFiles), [dedupedFiles]);
  const downloadableFiles = useMemo(
    () => dedupedFiles.filter((f) => f.downloadable),
    [dedupedFiles]
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(downloadableFiles.map((f) => getFileId(f)))
  );
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [statusMsg, setStatusMsg] = useState("");

  const [episodeMap, setEpisodeMap] = useState<Map<string, EpisodeState>>(() => {
    const m = new Map<string, EpisodeState>();
    for (const f of downloadableFiles) {
      const id = getFileId(f);
      m.set(id, {
        status: f.resolvedUrl ? "resolved" : "queued",
        downloadUrl: f.resolvedUrl,
      });
    }
    return m;
  });
  const [resolutionStarted, setResolutionStarted] = useState(false);
  const [resolutionComplete, setResolutionComplete] = useState(false);
  const [resolutionSummary, setResolutionSummary] = useState<{ resolved: number; failed: number; total: number } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const resolutionInitiated = useRef(false);

  const startResolution = useCallback(async () => {
    if (!jobId || resolutionStarted) return;
    setResolutionStarted(true);

    try {
      await fetch(`/api/resolve/${jobId}`, { method: "POST" });
    } catch {
      setError("Failed to start resolution");
      return;
    }

    const es = new EventSource(`/api/resolve/${jobId}/events`);
    eventSourceRef.current = es;

    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as ResolutionEvent;

        if (event.type === "episode_resolved" && event.episodeId) {
          setEpisodeMap((prev) => {
            const next = new Map(prev);
            const existing = next.get(event.episodeId!);
            if (existing) {
              next.set(event.episodeId!, {
                ...existing,
                status: "resolved",
                downloadUrl: event.downloadUrl,
                filename: event.filename,
              });
            }
            return next;
          });
        } else if (event.type === "episode_failed" && event.episodeId) {
          setEpisodeMap((prev) => {
            const next = new Map(prev);
            const existing = next.get(event.episodeId!);
            if (existing) {
              next.set(event.episodeId!, {
                ...existing,
                status: "failed",
                error: event.reason,
              });
            }
            return next;
          });
        } else if (event.type === "episode_resolving" && event.episodeId) {
          setEpisodeMap((prev) => {
            const next = new Map(prev);
            const existing = next.get(event.episodeId!);
            if (existing) {
              next.set(event.episodeId!, {
                ...existing,
                status: "resolving",
              });
            }
            return next;
          });
        } else if (event.type === "resolution_complete") {
          setResolutionComplete(true);
          setResolutionSummary({
            resolved: event.resolved || 0,
            failed: event.failed || 0,
            total: event.total || 0,
          });
          es.close();
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        es.close();
      }
    };
  }, [jobId, resolutionStarted]);

  useEffect(() => {
    if (jobId && downloadableFiles.length > 0 && !resolutionInitiated.current) {
      resolutionInitiated.current = true;
      startResolution();
    }
    return () => {
      eventSourceRef.current?.close();
    };
  }, [jobId, downloadableFiles.length, startResolution]);

  useEffect(() => {
    const currentIds = downloadableFiles.map((f) => getFileId(f)).sort().join(",");
    if (prevFileIdsRef.current && prevFileIdsRef.current !== currentIds) {
      setSelectedIds(new Set(downloadableFiles.map((f) => getFileId(f))));
    }
    prevFileIdsRef.current = currentIds;
  }, [downloadableFiles]);

  const prevFileIdsRef = useRef<string>("");

  const toggleFile = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(downloadableFiles.map((f) => getFileId(f))));
  const deselectAll = () => setSelectedIds(new Set());

  const handleSingleDownload = useCallback(async (file: DiscoveredFile) => {
    const fileId = getFileId(file);
    const ep = episodeMap.get(fileId);
    if (!ep || ep.status !== "resolved") return;
    setDownloadingId(fileId);
    setError("");

    try {
      const url = ep.downloadUrl || file.resolvedUrl;
      if (url) {
        triggerBrowserDownload(url, ep.filename || getDisplayName(file, 0));
      } else {
        await proxyDownload(file);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setTimeout(() => setDownloadingId(null), 1000);
    }
  }, [episodeMap]);

  const handleDownloadAll = useCallback(async () => {
    const resolvedEpisodes = downloadableFiles.filter((file) => {
      const ep = episodeMap.get(getFileId(file));
      return ep?.status === "resolved" && (ep?.downloadUrl || file.resolvedUrl);
    });
    if (resolvedEpisodes.length === 0) return;

    setError("");
    setStatusMsg("");
    setDownloadingId("all");

    for (let i = 0; i < resolvedEpisodes.length; i++) {
      const file = resolvedEpisodes[i];
      const fileId = getFileId(file);
      const ep = episodeMap.get(fileId);
      setDownloadingId(fileId);
      try {
        const url = ep?.downloadUrl || file.resolvedUrl;
        if (url) {
          triggerBrowserDownload(url, ep?.filename || getDisplayName(file, i));
        } else {
          await proxyDownload(file);
        }
      } catch {
        // skip failed files silently
      }
      if (i < resolvedEpisodes.length - 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    setDownloadingId(null);
    setStatusMsg(`All ${resolvedEpisodes.length} file(s) download started`);
    setTimeout(() => setStatusMsg(""), 4000);
  }, [downloadableFiles, episodeMap]);

  const resolvedCount = Array.from(episodeMap.values()).filter((e) => e.status === "resolved").length;
  const failedCount = Array.from(episodeMap.values()).filter((e) => e.status === "failed").length;
  const resolvingCount = Array.from(episodeMap.values()).filter((e) => e.status === "resolving").length;
  const queuedCount = Array.from(episodeMap.values()).filter((e) => e.status === "queued").length;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <CardTitle>{analysis.title || "Untitled Collection"}</CardTitle>
              <p className="text-sm text-gray-400">{analysis.originalUrl}</p>
            </div>
            {analysis.thumbnail && (
              <img
                src={analysis.thumbnail}
                alt={analysis.title || "Collection"}
                className="h-20 w-20 rounded-lg object-cover"
              />
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-4 text-center">
            <div>
              <div className="text-2xl font-bold text-white">{analysis.statistics.discovered}</div>
              <div className="text-sm text-gray-400">Discovered</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-green-400">{analysis.statistics.downloadable}</div>
              <div className="text-sm text-gray-400">Ready</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-yellow-400">{analysis.statistics.inaccessible}</div>
              <div className="text-sm text-gray-400">Inaccessible</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-white">
                {analysis.statistics.totalSize > 0 ? formatBytes(analysis.statistics.totalSize) : "N/A"}
              </div>
              <div className="text-sm text-gray-400">Total Size</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {!resolutionComplete && resolutionStarted && (
        <Card>
          <CardContent className="py-3">
            <div className="flex items-center gap-3">
              <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
              <div className="flex-1">
                <div className="text-sm text-gray-300">
                  Resolving download links...
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {resolvedCount} / {episodeMap.size} resolved
                  {failedCount > 0 && ` (${failedCount} failed)`}
                </div>
              </div>
              <div className="text-xs text-gray-500">
                {resolvedCount}/{episodeMap.size}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {resolutionComplete && resolutionSummary && (
        <Card>
          <CardContent className="py-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-green-400">{"\u2713"} Resolution complete</span>
              <span className="text-gray-400">
                {resolutionSummary.resolved} resolved, {resolutionSummary.failed} failed
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {analysis.statistics.inaccessible > 0 && (
        <Card>
          <CardContent className="py-3">
            <p className="text-sm text-gray-400">
              {analysis.statistics.inaccessible} resource(s) could not be verified as downloadable.
            </p>
          </CardContent>
        </Card>
      )}

      {analysis.warnings && analysis.warnings.length > 0 && (
        <Card>
          <CardContent className="py-3 space-y-1">
            {analysis.warnings.map((w, i) => {
              const isFallback = w.code === "FALLBACK_USED";
              const isNoResult = w.code === "NO_FALLBACK_RESULTS" || w.code === "NO_FALLBACK";
              return (
                <div
                  key={i}
                  className={`text-sm ${
                    isFallback
                      ? "text-blue-400"
                      : isNoResult
                        ? "text-yellow-400/80"
                        : "text-gray-400"
                  }`}
                >
                  {isFallback && <span className="mr-1">{"\u2139"}</span>}
                  {w.message}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {derivedQualities.length > 1 && (
        <Card>
          <CardContent className="py-3">
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <span>Qualities:</span>
              {derivedQualities.map((q) => (
                <Badge key={q} variant="outline" className="text-xs">{q}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Files ({selectedIds.size} / {downloadableFiles.length} selected)</CardTitle>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={selectAll}>Select All</Button>
              <Button variant="ghost" size="sm" onClick={deselectAll}>Deselect All</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="max-h-96 space-y-1 overflow-y-auto">
            {dedupedFiles.map((file, idx) => {
              const isSeasonPack = file.isSeasonPack;
              const displayName = getDisplayName(file, idx);
              const fileKey = getFileId(file);
              const isDownloading = downloadingId === fileKey;
              const ep = episodeMap.get(fileKey);
              const isResolved = ep?.status === "resolved";
              const isFailed = ep?.status === "failed";
              const isResolving = ep?.status === "resolving";
              const resolvedUrl = ep?.downloadUrl || file.resolvedUrl;

              return (
                <div
                  key={fileKey}
                  className={`flex items-center gap-3 rounded-lg border p-3 ${
                    !file.downloadable
                      ? "border-gray-800 opacity-50"
                      : isSeasonPack
                        ? "border-amber-700/50 bg-amber-900/10"
                        : "border-gray-700 hover:border-gray-600"
                  }`}
                >
                  {file.downloadable && (
                    <Checkbox
                      checked={selectedIds.has(fileKey)}
                      onCheckedChange={() => toggleFile(fileKey)}
                    />
                  )}
                  {!file.downloadable && <div className="w-4" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white truncate">
                      {isSeasonPack && <span className="text-amber-400 mr-1">{"\u{1F4E6}"}</span>}
                      {displayName}
                    </div>
                    <div className="text-xs text-gray-500">
                      {file.fileType} {file.size ? `\u00B7 ${formatBytes(file.size)}` : ""}
                      {file.episode ? ` \u00B7 Episode ${file.episode}` : ""}
                      {isSeasonPack && file.episodeRange && ` \u00B7 Episodes ${file.episodeRange}`}
                      {isSeasonPack && " \u00B7 Season Pack"}
                    </div>
                  </div>
                  {file.quality && <Badge variant="outline">{file.quality}</Badge>}
                  {isSeasonPack && <Badge variant="warning">Archive</Badge>}
                  {!file.downloadable && file.downloadBlocked && (
                    <Badge variant="destructive">{file.downloadBlocked}</Badge>
                  )}
                  {isResolved && (
                    <Badge variant="success" className="text-xs">{"\u2713"} Resolved</Badge>
                  )}
                  {isFailed && (
                    <Badge variant="destructive" className="text-xs">Failed</Badge>
                  )}
                  {isResolving && file.downloadable && (
                    <Badge variant="outline" className="border-blue-700 text-blue-400 text-xs">
                      <Loader2 className="h-3 w-3 animate-spin mr-1 inline" />
                      Resolving...
                    </Badge>
                  )}
                  {!isResolved && !isFailed && !isResolving && file.downloadable && queuedCount > 0 && (
                    <Badge variant="outline" className="text-xs text-gray-500">Queued</Badge>
                  )}
                  {file.downloadable && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      disabled={isDownloading || isFailed || isResolving || ep?.status !== "resolved"}
                      onClick={() => handleSingleDownload(file)}
                      title={`Download ${displayName}`}
                    >
                      {isDownloading ? (
                        <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
                      ) : (
                        <Download className="h-4 w-4 text-gray-400 hover:text-white" />
                      )}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          {(() => {
            const packs = dedupedFiles.filter((f) => f.isSeasonPack);
            const individuals = dedupedFiles.filter((f) => !f.isSeasonPack && f.downloadable);
            const hasOverlap = packs.length > 0 && individuals.length > 0;
            if (!hasOverlap) return null;
            return (
              <div className="mt-3 rounded-lg border border-yellow-800/50 bg-yellow-900/10 p-3">
                <p className="text-xs text-yellow-300/80">
                  Both season pack(s) and individual episodes are available.
                </p>
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {statusMsg && (
        <div className="rounded-lg bg-green-900/30 border border-green-800 p-3 text-sm text-green-400 flex items-center gap-2">
          {statusMsg}
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-900/30 border border-red-800 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <Button
        onClick={handleDownloadAll}
        disabled={resolvedCount === 0 || downloadingId === "all"}
        size="lg"
        className="w-full rounded-xl bg-white text-black font-medium hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200"
      >
        {downloadingId === "all" ? (
          <span className="flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Downloading...
          </span>
        ) : (
          `Download ${resolvedCount} Episode${resolvedCount !== 1 ? "s" : ""}`
        )}
      </Button>
    </div>
  );
}

function getInitialAnalysis(): AnalysisResult | null {
  if (typeof window === "undefined") return null;
  const stored = sessionStorage.getItem("analyzeResult");
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

export function CollectionResults({ jobId }: { jobId?: string | null }) {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(() => {
    if (jobId) return null;
    return getInitialAnalysis();
  });
  const [loading, setLoading] = useState(() => !jobId && !getInitialAnalysis());
  const [error, setError] = useState("");
  const router = useRouter();
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!jobId || fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    fetch(`/api/crawl/${jobId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.result) {
          setAnalysis(data.result);
          sessionStorage.setItem("analyzeResult", JSON.stringify(data.result));
        } else if (data.status === "failed") {
          setError(data.result?.message || "Crawl failed");
        } else if (data.status === "crawling" || data.status === "queued") {
          setError("Crawl still in progress. Please wait...");
        } else {
          setError("Crawl result not available yet");
        }
      })
      .catch(() => setError("Failed to load crawl results"))
      .finally(() => setLoading(false));
  }, [jobId]);

  useEffect(() => {
    if (!jobId && !analysis) {
      router.push("/");
    }
  }, [jobId, analysis, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex items-center gap-3 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading crawl results...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-red-400">{error}</p>
          </CardContent>
        </Card>
        <Button onClick={() => router.push("/")} variant="outline" className="w-full" size="lg">
          Try Another URL
        </Button>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-500">No analysis results found.</div>
      </div>
    );
  }

  if (isErrorStatus(analysis.status)) {
    return <ErrorStateDisplay analysis={analysis} />;
  }

  return <SuccessStateDisplay analysis={analysis} jobId={jobId || null} />;
}
