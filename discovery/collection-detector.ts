import { DiscoveredFile, CollectionResult, Quality } from "../types";
import { extractEpisodeNumber, naturalSort, extractDomain } from "../lib/utils";

class CollectionDetector {
  detectCollection(
    resources: DiscoveredFile[],
    entryUrl: string,
    pageTitle?: string,
    metadata?: Record<string, string>
  ): CollectionResult {
    const sortedResources = this.sortResourcesNatural(resources);
    const collectionName = this.extractCollectionName(resources, pageTitle, metadata);
    const qualities = this.extractAvailableQualities(resources);
    const totalSize = resources.reduce((sum, f) => sum + (f.size || 0), 0) || undefined;
    const thumbnailUrl = this.findBestThumbnail(resources, metadata);
    const description = metadata?.description || metadata?.["og:description"] || undefined;

    return {
      title: collectionName,
      thumbnailUrl,
      sourceUrl: entryUrl,
      files: sortedResources,
      qualities,
      totalSize,
      metadata: metadata || {},
      collectionName,
      description,
    };
  }

  groupByFileType(resources: DiscoveredFile[]): Record<string, DiscoveredFile[]> {
    const groups: Record<string, DiscoveredFile[]> = {};
    for (const file of resources) {
      const key = file.fileType;
      if (!groups[key]) groups[key] = [];
      groups[key].push(file);
    }
    return groups;
  }

  groupByQuality(resources: DiscoveredFile[]): Map<Quality, DiscoveredFile[]> {
    const groups = new Map<Quality, DiscoveredFile[]>();
    for (const file of resources) {
      if (file.quality) {
        const existing = groups.get(file.quality) || [];
        existing.push(file);
        groups.set(file.quality, existing);
      }
    }
    return groups;
  }

  findFilesForQuality(resources: DiscoveredFile[], quality: Quality): DiscoveredFile[] {
    return resources.filter((f) => f.quality === quality && f.downloadable);
  }

  private sortResourcesNatural(resources: DiscoveredFile[]): DiscoveredFile[] {
    return [...resources].sort((a, b) => naturalSort(a.name, b.name));
  }

  private extractCollectionName(
    resources: DiscoveredFile[],
    pageTitle?: string,
    metadata?: Record<string, string>
  ): string {
    if (metadata?.title) return metadata.title;
    if (pageTitle) return pageTitle;
    if (resources.length > 0) {
      const first = resources[0].name;
      const episodeNum = extractEpisodeNumber(first);
      if (episodeNum !== null) {
        const baseName = first
          .replace(/ep(?:isode)?[\s._-]*\d+/i, "")
          .replace(/s\d+e\d+/i, "")
          .replace(/\d+$/, "")
          .replace(/[\s._-]+$/, "")
          .trim();
        if (baseName) return baseName;
      }
    }
    const domain = extractDomain(resources[0]?.url || "");
    if (domain) return `Collection from ${domain}`;
    return "Untitled Collection";
  }

  private extractAvailableQualities(resources: DiscoveredFile[]): Quality[] {
    const qualitySet = new Set<string>();
    for (const file of resources) {
      if (file.quality) qualitySet.add(file.quality);
    }
    if (qualitySet.size === 0) return ["Default"];
    return Array.from(qualitySet).sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  }

  private findBestThumbnail(
    resources: DiscoveredFile[],
    metadata?: Record<string, string>
  ): string | undefined {
    if (metadata?.thumbnail) return metadata.thumbnail;
    if (metadata?.["og:image"]) return metadata["og:image"];
    for (const file of resources) {
      if (file.thumbnailUrl) return file.thumbnailUrl;
      if (file.fileType === "image" && file.url) return file.url;
    }
    return undefined;
  }
}

export const collectionDetector = new CollectionDetector();
