"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { JobCard } from "../../components/job-card";
import { Card, CardContent } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import Link from "next/link";

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

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  useEffect(() => {
    if (session) {
      fetchJobs();
    }
  }, [session]);

  const fetchJobs = async () => {
    try {
      const res = await fetch("/api/jobs");
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs);
      }
    } catch {
      // Handle error
    } finally {
      setLoading(false);
    }
  };

  if (status === "loading" || loading) {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  const activeJobs = jobs.filter((j) =>
    ["analyzing", "queued", "downloading", "packaging"].includes(j.status)
  );
  const completedJobs = jobs.filter((j) =>
    ["completed", "partial"].includes(j.status)
  );
  const failedJobs = jobs.filter((j) =>
    ["failed", "cancelled"].includes(j.status)
  );

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-gray-400">
            Welcome back, {session?.user?.name || session?.user?.email}
          </p>
        </div>
        <Link href="/">
          <Button>New Job</Button>
        </Link>
      </div>

      {jobs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-4">
            <div className="text-gray-500">No jobs yet</div>
            <Link href="/">
              <Button variant="outline">Start your first download</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {activeJobs.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-white">Active Jobs</h2>
              <div className="grid gap-4">
                {activeJobs.map((job) => (
                  <JobCard key={job.jobId} job={job} />
                ))}
              </div>
            </div>
          )}

          {completedJobs.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-white">Completed</h2>
              <div className="grid gap-4">
                {completedJobs.map((job) => (
                  <JobCard key={job.jobId} job={job} />
                ))}
              </div>
            </div>
          )}

          {failedJobs.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-white">Failed</h2>
              <div className="grid gap-4">
                {failedJobs.map((job) => (
                  <JobCard key={job.jobId} job={job} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
