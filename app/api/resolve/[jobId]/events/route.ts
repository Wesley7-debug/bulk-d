import { NextRequest } from "next/server";
import { getJob, getEventHistory, subscribeToEvents } from "../../../../../lib/job-store";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const job = getJob(jobId);

  if (!job) {
    return new Response(JSON.stringify({ error: "Job not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      function sendEvent(event: unknown) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch { /* controller closed */ }
      }

      const history = getEventHistory(jobId);
      for (const event of history) {
        sendEvent(event);
      }

      if (job.status === "completed" || job.status === "failed") {
        sendEvent({ type: "stream_end", jobId, status: job.status });
        controller.close();
        return;
      }

      const unsubscribe = subscribeToEvents(jobId, (event) => {
        sendEvent(event);
        if (event.type === "resolution_complete" || event.type === "crawl_failed") {
          setTimeout(() => {
            try { controller.close(); } catch { /* already closed */ }
          }, 100);
        }
      });

      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepAlive);
        }
      }, 15000);

      void unsubscribe;
      void keepAlive;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
