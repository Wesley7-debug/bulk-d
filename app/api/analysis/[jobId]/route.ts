import { NextRequest, NextResponse } from "next/server";
import { logger } from "../../../../lib/logger";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const logs = logger.getLogs(jobId);

  if (logs.length === 0) {
    return NextResponse.json(
      { error: `No analysis logs found for job ${jobId}` },
      { status: 404 }
    );
  }

  const stages = logs.map((l) => l.stage);
  const uniqueStages = [...new Set(stages)];

  const latestByStage: Record<string, typeof logs[0]> = {};
  for (const log of logs) {
    latestByStage[log.stage] = log;
  }

  return NextResponse.json({
    jobId,
    totalLogs: logs.length,
    stages: uniqueStages,
    latestByStage,
    logs,
  });
}
