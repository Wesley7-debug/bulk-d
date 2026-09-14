import { AnalysisResult, SearchResponse } from "../types";
import { analyzeUrl } from "./crawler";
import { searchProvider } from "../lib/search/search-provider";
import { GenericPageAdapter } from "./generic-page-adapter";
import { BaseAdapter } from "./base-adapter";

export { analyzeUrl };
export { BaseAdapter };
export { GenericPageAdapter };

const adapters: BaseAdapter[] = [new GenericPageAdapter()];

export function registerAdapter(adapter: BaseAdapter): void {
  adapters.push(adapter);
}

export function getAdapters(): readonly BaseAdapter[] {
  return adapters;
}

export async function searchAndAnalyze(
  query: string,
  numResults?: number
): Promise<SearchResponse> {
  return searchProvider.search(query, numResults);
}

export async function analyzeSearchResult(url: string): Promise<AnalysisResult> {
  return analyzeUrl(url);
}

export async function crawlOnly(url: string, jobId?: string): Promise<AnalysisResult> {
  const { TargetedCrawler } = await import("./crawler");
  const crawler = new TargetedCrawler(url, jobId, true);
  return crawler.analyze(url);
}
