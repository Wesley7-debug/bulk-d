"use client";

import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { formatBytes } from "../lib/utils";

interface Job {
  _id: string;
  jobId: string;
  collectionTitle: string;
  status: string;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  quality: string;
  zipSize?: number;
  thumbnailUrl?: string;
  createdAt: string;
}

const statusVariants: Record<string, "default" | "success" | "warning" | "destructive"> = {
  analyzing: "default",
  queued: "warning",
  downloading: "default",
  packaging: "default",
  completed: "success",
  failed: "destructive",
  partial: "warning",
  cancelled: "default",
};

export function JobCard({ job }: { job: Job }) {
  const date = new Date(job.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <Link href={`/jobs/${job.jobId}`}>
      <Card className="cursor-pointer transition-colors hover:border-gray-600">
        <CardHeader>
          <div className="flex items-start gap-3">
            {job.thumbnailUrl && (
              <img
                src={job.thumbnailUrl}
                alt={job.collectionTitle}
                className="h-12 w-12 rounded-lg object-cover"
              />
            )}
            <div className="flex-1 min-w-0">
              <CardTitle className="text-sm truncate">{job.collectionTitle}</CardTitle>
              <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                <span>{date}</span>
                <span>·</span>
                <span>{job.quality}</span>
              </div>
            </div>
            <Badge variant={statusVariants[job.status] || "default"}>
              {job.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-400">
              {job.completedFiles} / {job.totalFiles} files
            </span>
            {job.zipSize && (
              <span className="text-gray-400">{formatBytes(job.zipSize)}</span>
            )}
            {job.failedFiles > 0 && (
              <span className="text-red-400">{job.failedFiles} failed</span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
