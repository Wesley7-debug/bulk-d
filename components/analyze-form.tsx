"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

export function AnalyzeForm() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"url" | "search">("url");
  const router = useRouter();

  const isUrl = (value: string): boolean => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol);
    } catch {
      return false;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) {
      setError(mode === "url" ? "Please enter a URL" : "Please enter a search query");
      return;
    }

    setLoading(true);
    setError("");

    const isInputUrl = isUrl(input.trim());
    const actualMode = isInputUrl ? "url" : "search";

    try {
      const body =
        actualMode === "url"
          ? { url: input.trim() }
          : { search: input.trim() };

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Analysis failed");
      }

      if (data.type === "search" && data.data?.results) {
        sessionStorage.setItem("searchResults", JSON.stringify(data.data));
        router.push("/search");
      } else {
        sessionStorage.setItem("analyzeResult", JSON.stringify(data.data));
        router.push("/analyze");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const placeholders: Record<string, string> = {
    url: "https://example.com/collection",
    search: "Search for a series, movie, or media...",
  };

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-2xl space-y-4">
      <div className="space-y-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("url")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === "url"
                ? "bg-white text-black"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            URL
          </button>
          <button
            type="button"
            onClick={() => setMode("search")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === "search"
                ? "bg-white text-black"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            Search
          </button>
        </div>
        <Input
          placeholder={placeholders[mode]}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
        />
      </div>

      <div className="flex items-center gap-2 text-xs text-gray-500">
        {mode === "url" ? (
          <span>Paste a URL to a public media collection or website</span>
        ) : (
          <span>Search for any media content across the web</span>
        )}
      </div>

      {error && (
        <div className="rounded-lg bg-red-900/30 border border-red-800 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <Button type="submit" disabled={loading} className="w-full" size="lg">
        {loading ? (
          <span className="flex items-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {mode === "url" ? "Analyzing..." : "Searching..."}
          </span>
        ) : mode === "url" ? (
          "Analyze Collection"
        ) : (
          "Search"
        )}
      </Button>
    </form>
  );
}
