import { JobProgress } from "../../../components/job-progress";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <div className="mx-auto max-w-2xl py-8 space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-white">Job Status</h1>
        <p className="text-sm text-gray-400">Job ID: {id}</p>
      </div>
      <JobProgress jobId={id} />
    </div>
  );
}
