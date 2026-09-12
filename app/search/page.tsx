"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

interface SearchResult {
  title: string;
  url: string;
  domain: string;
  description: string;
  thumbnailUrl?: string;
}

interface SearchData {
  query: string;
  results: SearchResult[];
  totalResults: number;
}

function getInitialData(): SearchData | null {
  if (typeof window === "undefined") return null;
  const stored = sessionStorage.getItem("searchResults");
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

export default function SearchPage() {
  const [searchData, setSearchData] = useState<SearchData | null>(getInitialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [analyzingUrl, setAnalyzingUrl] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(() => {
    const data = getInitialData();
    return data?.query || "";
  });
  const router = useRouter();

  useEffect(() => {
    if (!searchData) {
      router.push("/");
    }
  }, [searchData, router]);

  const handleNewSearch = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!searchInput.trim()) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ search: searchInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");
      setSearchData(data.data);
      sessionStorage.setItem("searchResults", JSON.stringify(data.data));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  };

  const handleSelectResult = async (url: string) => {
    setAnalyzingUrl(url);
    setError("");

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      sessionStorage.removeItem("searchResults");
      sessionStorage.setItem("analyzeResult", JSON.stringify(data.data));
      router.push("/analyze");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
      setAnalyzingUrl(null);
    }
  };

  if (!searchData) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-500">Loading search results...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleNewSearch} className="flex gap-2">
        <Input
          placeholder="Search for media..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          disabled={loading}
          className="flex-1"
        />
        <Button type="submit" disabled={loading} variant="outline">
          {loading ? "Searching..." : "Search"}
        </Button>
      </form>

      {error && (
        <div className="rounded-lg bg-red-900/30 border border-red-800 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="text-sm text-gray-400">
        {searchData.totalResults > 0
          ? `Found ${searchData.totalResults.toLocaleString()} results for "${searchData.query}"`
          : `No results for "${searchData.query}"`}
      </div>

      <div className="space-y-3">
        {searchData.results.map((result) => (
          <Card
            key={result.url}
            className="cursor-pointer transition-colors hover:border-gray-600"
          >
            <CardHeader>
              <div className="flex items-start gap-4">
                {result.thumbnailUrl && (
                  <img
                    src={result.thumbnailUrl}
                    alt={result.title}
                    className="h-16 w-24 rounded object-cover"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <CardTitle className="text-base">{result.title}</CardTitle>
                  <p className="text-xs text-gray-500 mt-1">{result.domain}</p>
                  <p className="text-sm text-gray-400 mt-2 line-clamp-2">
                    {result.description}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleSelectResult(result.url)}
                  disabled={analyzingUrl === result.url}
                >
                  {analyzingUrl === result.url ? "Analyzing..." : "Analyze"}
                </Button>
              </div>
            </CardHeader>
          </Card>
        ))}
      </div>

      {searchData.results.length === 0 && (
        <div className="text-center py-12">
          <p className="text-gray-500">
            No results found. Try a different search query.
          </p>
          <Button
            variant="ghost"
            className="mt-4"
            onClick={() => router.push("/")}
          >
            Back to Home
          </Button>
        </div>
      )}
    </div>
  );
}
