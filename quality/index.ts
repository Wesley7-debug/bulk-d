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
  const priorities: Record<Quality, number> = {
    "360p": 1,
    "480p": 2,
    "720p": 3,
    "1080p": 4,
  };
  return priorities[quality];
}

export function detectQualityFromUrl(url: string): Quality | undefined {
  const lower = url.toLowerCase();
  if (lower.includes("1080") || lower.includes("1080p")) return "1080p";
  if (lower.includes("720") || lower.includes("720p")) return "720p";
  if (lower.includes("480") || lower.includes("480p")) return "480p";
  if (lower.includes("360") || lower.includes("360p")) return "360p";
  return undefined;
}

export function detectQualityFromMetadata(metadata: Record<string, string>): Quality | undefined {
  const height = metadata["height"] || metadata["yt-dlp:height"];
  if (height) {
    const h = parseInt(height);
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    if (h >= 360) return "360p";
  }
  const quality = metadata["quality"] || metadata["resolution"];
  if (quality) {
    const q = quality.toLowerCase();
    if (q.includes("1080")) return "1080p";
    if (q.includes("720")) return "720p";
    if (q.includes("480")) return "480p";
    if (q.includes("360")) return "360p";
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
        (a, b) => getQualityPriority(b.quality || "360p") - getQualityPriority(a.quality || "360p")
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
