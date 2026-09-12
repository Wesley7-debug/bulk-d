import { AnalyzeForm } from "../components/analyze-form";

export default function HomePage() {
  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center space-y-12">
      <div className="space-y-4 text-center">
        <h1 className="text-5xl font-bold tracking-tight">
          Bulk<span className="text-gray-400">Forge</span>
        </h1>
        <p className="mx-auto max-w-xl text-lg text-gray-400">
          Enter any URL or search query. BulkForge discovers, crawls,
          and downloads all publicly available media as a single ZIP.
        </p>
      </div>

      <AnalyzeForm />

      <div className="grid max-w-2xl grid-cols-3 gap-6 text-center text-sm text-gray-500">
        <div className="space-y-2">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-gray-800">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <div>URL or Search</div>
        </div>
        <div className="space-y-2">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-gray-800">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </div>
          <div>Select files & quality</div>
        </div>
        <div className="space-y-2">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-gray-800">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </div>
          <div>Download as ZIP</div>
        </div>
      </div>
    </div>
  );
}
