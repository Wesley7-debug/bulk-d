"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Quality,
  AnalysisResult,
  AnalysisStatus,
  AccessStatus,
} from "../types";
import { Button } from "./ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Checkbox } from "./ui/checkbox";
import { formatBytes } from "../lib/utils";

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
  const availableQualities = analysis.availableQualities;
  const [selectedQuality, setSelectedQuality] = useState<Quality>(
    availableQualities.length > 0 ? availableQualities[availableQualities.length - 1] : "default"
  );
  const downloadableFiles = analysis.files.filter((f) => f.downloadable);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(
    () => new Set(downloadableFiles.map((f) => f.url))
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const toggleFile = (url: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const selectAll = () => setSelectedFiles(new Set(downloadableFiles.map((f) => f.url)));
  const deselectAll = () => setSelectedFiles(new Set());

  const handleDownload = async () => {
    if (selectedFiles.size === 0) return;
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceUrl: analysis.originalUrl,
          collectionTitle: analysis.title || "Untitled Collection",
          quality: selectedQuality,
          fileUrls: Array.from(selectedFiles),
          thumbnailUrl: analysis.thumbnail,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create job");
      sessionStorage.removeItem("analyzeResult");
      router.push(`/jobs/${data.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start download");
    } finally {
      setLoading(false);
    }
  };

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
              <div className="text-sm text-gray-400">Downloadable</div>
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
              {analysis.statistics.inaccessible} resource(s) were discovered but could not be verified as downloadable.
              These may be protected, require authentication, or have other access restrictions.
            </p>
          </CardContent>
        </Card>
      )}

      {availableQualities.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Quality</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              {availableQualities.map((q) => (
                <Button
                  key={q}
                  variant={selectedQuality === q ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedQuality(q)}
                >
                  {q}
                </Button>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-500">
              Applies to all files. Files without this quality will be marked unavailable.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Files ({selectedFiles.size} / {downloadableFiles.length} selected)</CardTitle>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={selectAll}>Select All</Button>
              <Button variant="ghost" size="sm" onClick={deselectAll}>Deselect All</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {analysis.files.map((file) => {
              const isSeasonPack = file.isSeasonPack;
              return (
                <div
                  key={file.url}
                  className={`flex items-center gap-3 rounded-lg border p-3 ${
                    isSeasonPack
                      ? "border-amber-700/50 bg-amber-900/10"
                      : file.downloadable
                        ? "border-gray-700 hover:border-gray-600"
                        : "border-gray-800 opacity-50"
                  }`}
                >
                  <Checkbox
                    checked={selectedFiles.has(file.url)}
                    onCheckedChange={() => toggleFile(file.url)}
                    disabled={!file.downloadable}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white truncate">
                      {isSeasonPack && <span className="text-amber-400 mr-1">📦</span>}
                      {file.name}
                    </div>
                    <div className="text-xs text-gray-500">
                      {file.fileType} {file.size ? `\u00B7 ${formatBytes(file.size)}` : ""}
                      {isSeasonPack && file.episodeRange && ` \u00B7 Episodes ${file.episodeRange}`}
                      {isSeasonPack && " \u00B7 Season Pack"}
                    </div>
                  </div>
                  {file.quality && <Badge variant="outline">{file.quality}</Badge>}
                  {isSeasonPack && <Badge variant="warning">Archive</Badge>}
                  {!file.downloadable && (
                    <Badge variant="destructive">{file.downloadBlocked || "Not available"}</Badge>
                  )}
                </div>
              );
            })}
          </div>
          {(() => {
            const packs = analysis.files.filter((f) => f.isSeasonPack);
            const individuals = analysis.files.filter((f) => !f.isSeasonPack && f.downloadable);
            const hasOverlap = packs.length > 0 && individuals.length > 0;
            if (!hasOverlap) return null;
            return (
              <div className="mt-3 rounded-lg border border-yellow-800/50 bg-yellow-900/10 p-3">
                <p className="text-xs text-yellow-300/80">
                  Both season pack(s) and individual episodes are selected. You may be downloading duplicate content.
                  Consider selecting only the season pack, or only individual episodes.
                </p>
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-lg bg-red-900/30 border border-red-800 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <Button
        onClick={handleDownload}
        disabled={loading || selectedFiles.size === 0}
        size="lg"
        className="w-full"
      >
        {loading ? "Starting..." : `Download ${selectedFiles.size} Files as ZIP`}
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
