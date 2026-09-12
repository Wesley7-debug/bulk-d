import * as cheerio from "cheerio";
import { BaseAdapter } from "./base-adapter";
import { CollectionResult, DiscoveredFile, Quality, FileType } from "../types";
import { discovery } from "../discovery/index";

export class GenericPageAdapter extends BaseAdapter {
  name = "generic-page";

  canHandle(url: string): boolean {
    try {
      const parsed = new URL(url);
      return ["http:", "https:"].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  async analyze(url: string): Promise<CollectionResult> {
    const html = await this.fetchPage(url);
    const $ = cheerio.load(html);

    const title =
      $("title").text().trim() ||
      $('meta[property="og:title"]').attr("content") ||
      $("h1").first().text().trim() ||
      "Untitled Collection";

    const thumbnailUrl =
      $('meta[property="og:image"]').attr("content") ||
      $("meta[name='twitter:image']").attr("content") ||
      undefined;

    const discoveredFiles = await discovery.findDownloadableResources($, url);

    const qualities = this.extractAvailableQualities(discoveredFiles);

    const totalSize = discoveredFiles.reduce((sum, f) => sum + (f.size || 0), 0) || undefined;

    return {
      title,
      thumbnailUrl,
      sourceUrl: url,
      files: discoveredFiles,
      qualities,
      totalSize,
    };
  }

  private extractAvailableQualities(files: DiscoveredFile[]): Quality[] {
    const qualitySet = new Set<Quality>();
    for (const file of files) {
      if (file.quality) {
        qualitySet.add(file.quality);
      }
    }
    const allQualities: Quality[] = ["360p", "480p", "720p", "1080p"];
    if (qualitySet.size === 0) {
      return allQualities;
    }
    return allQualities.filter((q) => qualitySet.has(q));
  }
}
