"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/button";

export function AnalyzeForm() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [focused, setFocused] = useState(false);
  const [progress, setProgress] = useState("");
  const router = useRouter();
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isUrl = (value: string): boolean => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol);
    } catch {
      return false;
    }
  };

  const pollCrawlStatus = async (jobId: string) => {
    try {
      const res = await fetch(`/api/crawl/${jobId}`);
      if (!res.ok) return;

      const data = await res.json();

      if (data.status === "ready") {
        setProgress("Crawl complete! Navigating to analysis...");
        router.push(`/analyze?jobId=${jobId}`);
        return;
      }

      if (data.status === "failed") {
        setError(data.result?.message || "Crawl failed. Please try a different URL.");
        setLoading(false);
        setProgress("");
        return;
      }

      const events = data.events || [];
      const lastEvent = events[events.length - 1];
      if (lastEvent?.message) {
        setProgress(lastEvent.message);
      }

      pollRef.current = setTimeout(() => pollCrawlStatus(jobId), 1000);
    } catch {
      pollRef.current = setTimeout(() => pollCrawlStatus(jobId), 2000);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) {
      setError("Enter a URL to get started");
      return;
    }

    if (!isUrl(input.trim())) {
      setError("Please enter a valid URL starting with http:// or https://");
      return;
    }

    setLoading(true);
    setError("");
    setProgress("Connecting to site...");

    try {
      const res = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: input.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to start crawl");
      }

      setProgress("Crawling pages...");
      pollCrawlStatus(data.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setProgress("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-2xl space-y-4">
      <div className="relative">
        <div
          className={`relative rounded-xl border transition-all duration-200 ${
            focused
              ? "border-gray-500/50 bg-white/[0.04] shadow-[0_0_20px_rgba(255,255,255,0.03)]"
              : "border-gray-800/80 bg-white/[0.02]"
          }`}
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <svg
              className={`h-5 w-5 shrink-0 transition-colors ${
                focused ? "text-gray-300" : "text-gray-600"
              }`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
              />
            </svg>
            <input
              type="text"
              placeholder="https://example.com/tv-series/your-show-season-1"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              disabled={loading}
              className="flex-1 bg-transparent text-sm text-white placeholder-gray-600 outline-none"
            />
            {input && !loading && (
              <button
                type="button"
                onClick={() => setInput("")}
                className="text-gray-600 hover:text-gray-400 transition-colors"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <p className="mt-2 px-1 text-xs text-gray-600">
          Paste a URL to a public media collection or season page
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800/50 bg-red-950/30 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {progress && !error && (
        <div className="flex items-center gap-2 px-1 text-xs text-gray-500">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
          {progress}
        </div>
      )}

      <Button
        type="submit"
        disabled={loading || !input.trim()}
        className="w-full rounded-xl bg-white text-black font-medium hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200"
        size="lg"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            Crawling...
          </span>
        ) : (
          "Analyze"
        )}
      </Button>

      <div className="text-center">
        <span className="text-xs text-gray-700">
          Search coming soon &mdash; use a direct URL for now
        </span>
      </div>
    </form>
  );
}
