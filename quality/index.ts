import { Quality, DiscoveredFile } from "../types";
import { extractEpisodeNumber } from "../lib/utils";

export function filterFilesByQuality(
  files: DiscoveredFile[],
  requestedQuality: Quality
): DiscoveredFile[] {
  return files.filter((file) => {
    if (!file.quality) return true;
    return file.quality === requestedQuality;
  });
}

export function markUnavailableFiles(
  files: DiscoveredFile[],
  requestedQuality: Quality
): DiscoveredFile[] {
  return files.map((file) => {
    if (file.quality && file.quality !== requestedQuality) {
      return {
        ...file,
        downloadable: false,
        downloadBlocked: `Available in ${file.quality}, not ${requestedQuality}`,
        errorState: "NOT_DOWNLOADABLE" as const,
      };
    }
    return file;
  });
}

export function getQualityPriority(quality: Quality): number {
  const numeric = parseInt(quality, 10);
  if (Number.isFinite(numeric)) return numeric;
  if (quality === "Default") return 0;
  return -1;
}

export function detectQualityFromUrl(url: string): Quality | undefined {
  const lower = url.toLowerCase();
  const match = lower.match(/\b(\d{3,4})p\b/);
  if (match) return `${match[1]}p`;
  return undefined;
}

export function detectQualityFromMetadata(metadata: Record<string, string>): Quality | undefined {
  const height = metadata["height"] || metadata["yt-dlp:height"];
  if (height) {
    const h = parseInt(height);
    if (Number.isFinite(h) && h > 0) return `${h}p`;
  }
  const quality = metadata["quality"] || metadata["resolution"];
  if (quality) {
    const q = quality.toLowerCase();
    const match = q.match(/\b(\d{3,4})p?\b/);
    if (match) return `${match[1]}p`;
    if (q.includes("hd")) return "720p";
    if (q.includes("sd")) return "480p";
  }
  return undefined;
}

export function selectBestQuality(
  availableQualities: Quality[],
  requestedQuality: Quality
): Quality | null {
  if (availableQualities.includes(requestedQuality)) return requestedQuality;
  const sorted = [...availableQualities].sort(
    (a, b) => getQualityPriority(b) - getQualityPriority(a)
  );
  for (const q of sorted) {
    if (getQualityPriority(q) <= getQualityPriority(requestedQuality)) return q;
  }
  return sorted[sorted.length - 1] || null;
}

export function groupFilesByEpisode(
  files: DiscoveredFile[]
): Map<number, DiscoveredFile[]> {
  const groups = new Map<number, DiscoveredFile[]>();

  for (const file of files) {
    const ep = extractEpisodeNumber(file.name);
    if (ep !== null) {
      const existing = groups.get(ep) || [];
      existing.push(file);
      groups.set(ep, existing);
    } else {
      const maxKey = Math.max(0, ...Array.from(groups.keys()));
      groups.set(maxKey + 1, [file]);
    }
  }

  return groups;
}

export function selectFilesForQuality(
  files: DiscoveredFile[],
  requestedQuality: Quality
): DiscoveredFile[] {
  const grouped = groupFilesByEpisode(files);
  const selected: DiscoveredFile[] = [];

  for (const [, episodeFiles] of grouped) {
    const qualityMatch = episodeFiles.find(
      (f) => f.quality === requestedQuality
    );
    if (qualityMatch) {
      selected.push(qualityMatch);
    } else {
      const bestAvailable = [...episodeFiles].sort(
        (a, b) => getQualityPriority(b.quality || "0p") - getQualityPriority(a.quality || "0p")
      )[0];
      if (bestAvailable) {
        selected.push({
          ...bestAvailable,
          downloadable: false,
          downloadBlocked: `Requested ${requestedQuality} not available. Available: ${episodeFiles.map((f) => f.quality).filter(Boolean).join(", ") || "unknown"}`,
        });
      }
    }
  }

  return selected;
}
