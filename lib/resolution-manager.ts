import { DiscoveredFile, ResolutionEvent } from "../types";
import { resolveStatic, resolveHostLink } from "../resolver/index";
import { emitEvent, updateEpisode, setJobStatus } from "./job-store";
import { logger } from "./logger";

function getConcurrency(): number {
  const envVal = process.env.RESOLUTION_CONCURRENCY;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 10;
}

export async function resolveEpisodes(
  jobId: string,
  files: DiscoveredFile[],
  concurrency?: number
): Promise<{ resolved: number; failed: number }> {
  const downloadable = files.filter((f) => f.downloadable && !f.resolvedUrl);
  const total = downloadable.length;
  const effectiveConcurrency = concurrency || getConcurrency();

  if (total === 0) {
    return { resolved: 0, failed: 0 };
  }

  setJobStatus(jobId, "resolving");

  emitEvent(jobId, {
    type: "resolution_started",
    jobId,
    total,
  } as ResolutionEvent);

  let resolvedCount = 0;
  let failedCount = 0;

  const nextIndex = { value: 0 };

  async function runWorker(): Promise<void> {
    while (nextIndex.value < total) {
      const i = nextIndex.value++;
      const file = downloadable[i];
      const name = file.name || file.url.split("/").pop() || `Episode ${i + 1}`;
      const episodeId = file.resourceId || file.url;

      updateEpisode(jobId, i, { status: "resolving", name });

      emitEvent(jobId, {
        type: "episode_resolving",
        jobId,
        index: i,
        total,
        episode: name,
        episodeId,
      } as ResolutionEvent);

      logger.log(jobId, "RESOLVE_WORKER", `episode=${i} name=${name} start`);

      try {
        const resolveJobId = `resolve-${jobId}-${i}`;

        const staticResult = await resolveStatic(file.url, resolveJobId);
        if (staticResult) {
          file.resolvedUrl = staticResult.url;
          file.name = staticResult.filename || file.name;
          file.size = staticResult.size || file.size;
          if (staticResult.mimeType) file.mimeType = staticResult.mimeType;
          file.resolveStatus = "resolved";

          updateEpisode(jobId, i, {
            status: "resolved",
            resolvedUrl: staticResult.url,
            name: staticResult.filename || name,
          });

          emitEvent(jobId, {
            type: "episode_resolved",
            jobId,
            index: i,
            total,
            episode: name,
            episodeId,
            downloadUrl: staticResult.url,
            filename: staticResult.filename,
          } as ResolutionEvent);

          resolvedCount++;
          logger.log(jobId, "RESOLVE_WORKER", `episode=${i} name=${name} resolved_via=static`);
          continue;
        }

        const hostResult = await resolveHostLink(
          {
            landingUrl: file.url,
            filename: file.name || null,
            fileSize: null,
            confidence: 0.5,
            sourcePage: file.sourcePage || file.url,
          },
          resolveJobId
        );

        if (hostResult.success) {
          file.resolvedUrl = hostResult.finalUrl;
          file.name = hostResult.filename || file.name;
          file.size = hostResult.contentLength || file.size;
          if (hostResult.contentType) file.mimeType = hostResult.contentType;
          file.resolveStatus = "resolved";

          updateEpisode(jobId, i, {
            status: "resolved",
            resolvedUrl: hostResult.finalUrl,
            name: hostResult.filename || name,
          });

          emitEvent(jobId, {
            type: "episode_resolved",
            jobId,
            index: i,
            total,
            episode: name,
            episodeId,
            downloadUrl: hostResult.finalUrl,
            filename: hostResult.filename,
          } as ResolutionEvent);

          resolvedCount++;
          logger.log(jobId, "RESOLVE_WORKER", `episode=${i} name=${name} resolved_via=host_link`);
        } else {
          file.resolveStatus = "resolution_failed";

          updateEpisode(jobId, i, {
            status: "failed",
            error: hostResult.reason || "No valid source found",
          });

          emitEvent(jobId, {
            type: "episode_failed",
            jobId,
            index: i,
            total,
            episode: name,
            episodeId,
            reason: hostResult.reason || "No valid source found",
          } as ResolutionEvent);

          failedCount++;
          logger.log(jobId, "RESOLVE_WORKER", `episode=${i} name=${name} failed reason=${hostResult.reason}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        file.resolveStatus = "resolution_failed";

        updateEpisode(jobId, i, { status: "failed", error: msg });

        emitEvent(jobId, {
          type: "episode_failed",
          jobId,
          index: i,
          total,
          episode: name,
          episodeId,
          reason: msg,
        } as ResolutionEvent);

        failedCount++;
        logger.log(jobId, "RESOLVE_WORKER", `episode=${i} name=${name} error=${msg}`);
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(effectiveConcurrency, total); w++) {
    workers.push(runWorker());
  }

  await Promise.all(workers);

  setJobStatus(jobId, "completed");

  emitEvent(jobId, {
    type: "resolution_complete",
    jobId,
    total,
    resolved: resolvedCount,
    failed: failedCount,
  } as ResolutionEvent);

  logger.log(jobId, "RESOLVE_WORKER", `complete resolved=${resolvedCount} failed=${failedCount} total=${total} concurrency=${effectiveConcurrency}`);

  return { resolved: resolvedCount, failed: failedCount };
}
