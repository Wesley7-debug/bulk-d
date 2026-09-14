"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  AnalysisResult,
  AnalysisStatus,
  AccessStatus,
  DiscoveredFile,
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

function SuccessStateDisplay({ analysis }: { analysis: AnalysisResult }) {
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

  const prevFileIdsRef = useRef<string>("");

  useEffect(() => {
    const currentIds = downloadableFiles.map((f) => getFileId(f)).sort().join(",");
    if (prevFileIdsRef.current && prevFileIdsRef.current !== currentIds) {
      setSelectedIds(new Set(downloadableFiles.map((f) => getFileId(f))));
    }
    prevFileIdsRef.current = currentIds;
  }, [downloadableFiles]);

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
    setDownloadingId(fileId);
    setError("");

    try {
      if (file.resolvedUrl) {
        triggerBrowserDownload(file.resolvedUrl, getDisplayName(file, dedupedFiles.indexOf(file)));
      } else {
        await proxyDownload(file);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setTimeout(() => setDownloadingId(null), 1000);
    }
  }, [dedupedFiles]);

  const handleDownloadSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;

    const selectedFiles = downloadableFiles.filter(
      (f) => selectedIds.has(getFileId(f))
    );

    if (selectedFiles.length === 0) return;

    if (selectedFiles.length !== selectedIds.size) {
      console.warn(`[DOWNLOAD] Selection mismatch: ${selectedIds.size} selected but only ${selectedFiles.length} found in file list`);
    }

    setError("");
    const total = selectedFiles.length;
    let initiated = 0;
    let failed = 0;

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];

      setTimeout(async () => {
        try {
          if (file.resolvedUrl) {
            triggerBrowserDownload(file.resolvedUrl, getDisplayName(file, dedupedFiles.indexOf(file)));
          } else {
            await proxyDownload(file);
          }
          initiated++;
        } catch {
          failed++;
          setError(`Failed to initiate download for ${getDisplayName(file, dedupedFiles.indexOf(file))}`);
        }
      }, i * 200);
    }

    setStatusMsg(`Initiating ${total} download${total > 1 ? "s" : ""}...`);
    setTimeout(() => {
      if (failed > 0) {
        setStatusMsg(`Started ${initiated} download${initiated > 1 ? "s" : ""}, ${failed} failed`);
      } else {
        setStatusMsg(`Started ${total} download${total > 1 ? "s" : ""}`);
      }
      setTimeout(() => setStatusMsg(""), 3000);
    }, total * 200 + 500);
  }, [selectedIds, downloadableFiles, dedupedFiles]);

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

      {analysis.statistics.inaccessible > 0 && (
        <Card>
          <CardContent className="py-3">
            <p className="text-sm text-gray-400">
              {analysis.statistics.inaccessible} resource(s) could not be verified as downloadable.
            </p>
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
              const isResolved = file.resolveStatus === "resolved" && file.resolvedUrl;
              const isFailed = file.resolveStatus === "resolution_failed";
              const isResolving = file.resolveStatus === "ready_to_resolve" || file.resolveStatus === "resolving";

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
                    <Badge variant="success" className="text-xs">Resolved</Badge>
                  )}
                  {isFailed && (
                    <Badge variant="destructive" className="text-xs">Unable to resolve</Badge>
                  )}
                  {isResolving && file.downloadable && (
                    <Badge variant="outline" className="border-blue-700 text-blue-400 text-xs">
                      <Loader2 className="h-3 w-3 animate-spin mr-1 inline" />
                      Resolving...
                    </Badge>
                  )}
                  {file.downloadable && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      disabled={isDownloading || isFailed || isResolving}
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
        onClick={handleDownloadSelected}
        disabled={selectedIds.size === 0}
        size="lg"
        className="w-full"
      >
        {selectedIds.size === 1
          ? "Download Selected File"
          : `Download ${selectedIds.size} Selected Files`}
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

export function CollectionResults() {
  const [analysis] = useState<AnalysisResult | null>(getInitialAnalysis);
  const router = useRouter();

  useEffect(() => {
    if (!analysis) {
      router.push("/");
    }
  }, [analysis, router]);

  if (!analysis) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-500">Loading analysis results...</div>
      </div>
    );
  }

  if (isErrorStatus(analysis.status)) {
    return <ErrorStateDisplay analysis={analysis} />;
  }

  return <SuccessStateDisplay analysis={analysis} />;
}
