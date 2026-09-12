import { AnalysisResult, SearchResponse } from "../types";
import { analyzeUrl } from "./crawler";
import { searchProvider } from "../lib/search/search-provider";

export { analyzeUrl };

export async function searchAndAnalyze(
  query: string,
  numResults?: number
): Promise<SearchResponse> {
  return searchProvider.search(query, numResults);
}

export async function analyzeSearchResult(url: string): Promise<AnalysisResult> {
  return analyzeUrl(url);
}
