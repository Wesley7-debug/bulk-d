import { SearchResult, SearchResponse } from "../../types";
import { GOOGLE_SEARCH_API_KEY, GOOGLE_SEARCH_ENGINE_ID } from "../constants";

interface GoogleSearchItem {
  title: string;
  link: string;
  displayLink: string;
  snippet: string;
  pagemap?: {
    cse_thumbnail?: Array<{ src: string; width: string; height: string }>;
    cse_image?: Array<{ src: string }>;
    metatags?: Array<Record<string, string>>;
  };
}

interface GoogleSearchResponse {
  items?: GoogleSearchItem[];
  searchInformation?: {
    totalResults: string;
    formattedTotalResults: string;
  };
}

class SearchProvider {
  async search(query: string, numResults: number = 10): Promise<SearchResponse> {
    if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_ENGINE_ID) {
      throw new Error(
        "Google Search API not configured. Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_ENGINE_ID in .env.local"
      );
    }

    const params = new URLSearchParams({
      key: GOOGLE_SEARCH_API_KEY,
      cx: GOOGLE_SEARCH_ENGINE_ID,
      q: query,
      num: String(Math.min(numResults, 10)),
    });

    const url = `https://www.googleapis.com/customsearch/v1?${params.toString()}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
        },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error("Google Search API rate limit exceeded. Please try again later.");
        }
        if (response.status === 403) {
          throw new Error("Google Search API access denied. Check your API key and Search Engine ID.");
        }
        throw new Error(`Google Search API error: ${response.status} ${response.statusText}`);
      }

      const data: GoogleSearchResponse = await response.json();
      const results: SearchResult[] = [];

      if (data.items) {
        for (const item of data.items) {
          const thumbnailUrl =
            item.pagemap?.cse_thumbnail?.[0]?.src ||
            item.pagemap?.cse_image?.[0]?.src ||
            undefined;

          results.push({
            title: item.title,
            url: item.link,
            domain: item.displayLink,
            description: item.snippet,
            thumbnailUrl,
          });
        }
      }

      return {
        query,
        results,
        totalResults: parseInt(data.searchInformation?.totalResults || "0"),
      };
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new Error("Google Search request timed out. Please try again.");
        }
        throw error;
      }
      throw new Error("Google Search failed unexpectedly");
    }
  }
}

export const searchProvider = new SearchProvider();
