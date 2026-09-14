"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { CollectionResults } from "../../components/collection-results";

function AnalyzeContent() {
  const searchParams = useSearchParams();
  const jobId = searchParams.get("jobId");

  return (
    <div className="py-8">
      <CollectionResults jobId={jobId} />
    </div>
  );
}

export default function AnalyzePage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <div className="text-gray-500">Loading...</div>
        </div>
      }
    >
      <AnalyzeContent />
    </Suspense>
  );
}
