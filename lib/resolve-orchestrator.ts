import { DiscoveredFile, EpisodeResolveStatus } from "../types";
import { resolveStatic, resolveHostLink } from "../resolver/index";
import { updateEpisode, setJobStatus } from "./job-store";
import { logger } from "./logger";

export interface ResolveCallbacks {
  onEpisodeStart: (index: number, total: number, name: string) => void;
  onEpisodeComplete: (
    index: number,
    total: number,
    name: string,
    status: EpisodeResolveStatus,
    resolvedUrl?: string,
    error?: string
  ) => void;
}

export async function resolveEpisodesOneByOne(
  jobId: string,
  episodes: DiscoveredFile[],
  callbacks: ResolveCallbacks
): Promise<DiscoveredFile[]> {
  const total = episodes.length;
  setJobStatus(jobId, "resolving");

  const resolved: DiscoveredFile[] = [];

  for (let i = 0; i < total; i++) {
    const episode = episodes[i];
    const name = episode.name || episode.url.split("/").pop() || `Episode ${i + 1}`;

    updateEpisode(jobId, i, { status: "resolving", name });
    callbacks.onEpisodeStart(i, total, name);

    try {
      const resolveJobId = `resolve-${jobId}-${i}`;

      const staticResult = await resolveStatic(episode.url, resolveJobId);
      if (staticResult) {
        const resolvedEpisode: DiscoveredFile = {
          ...episode,
          resolvedUrl: staticResult.url,
          name: staticResult.filename || episode.name,
          size: staticResult.size || episode.size,
          mimeType: staticResult.mimeType || episode.mimeType,
          resolveStatus: "resolved",
        };
        resolved.push(resolvedEpisode);
        updateEpisode(jobId, i, {
          status: "resolved",
          resolvedUrl: staticResult.url,
          name: staticResult.filename || name,
        });
        callbacks.onEpisodeComplete(i, total, name, "resolved", staticResult.url);
        continue;
      }

      const hostResult = await resolveHostLink(
        {
          landingUrl: episode.url,
          filename: episode.name || null,
          fileSize: null,
          confidence: 0.5,
          sourcePage: episode.sourcePage || episode.url,
        },
        resolveJobId
      );

      if (hostResult.success) {
        const resolvedEpisode: DiscoveredFile = {
          ...episode,
          resolvedUrl: hostResult.finalUrl,
          name: hostResult.filename || episode.name,
          size: hostResult.contentLength || episode.size,
          mimeType: hostResult.contentType || episode.mimeType,
          resolveStatus: "resolved",
        };
        resolved.push(resolvedEpisode);
        updateEpisode(jobId, i, {
          status: "resolved",
          resolvedUrl: hostResult.finalUrl,
          name: hostResult.filename || name,
        });
        callbacks.onEpisodeComplete(i, total, name, "resolved", hostResult.finalUrl);
      } else {
        const failedEpisode: DiscoveredFile = {
          ...episode,
          resolveStatus: "resolution_failed",
        };
        resolved.push(failedEpisode);
        updateEpisode(jobId, i, {
          status: "failed",
          error: hostResult.reason || "no_media_found",
        });
        callbacks.onEpisodeComplete(i, total, name, "failed", undefined, hostResult.reason || "No valid download source found");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      const failedEpisode: DiscoveredFile = {
        ...episode,
        resolveStatus: "resolution_failed",
      };
      resolved.push(failedEpisode);
      updateEpisode(jobId, i, { status: "failed", error: msg });
      callbacks.onEpisodeComplete(i, total, name, "failed", undefined, msg);
      logger.log(jobId, "RESOLVE", `episode=${i} error=${msg}`);
    }
  }

  setJobStatus(jobId, "completed");
  return resolved;
}
