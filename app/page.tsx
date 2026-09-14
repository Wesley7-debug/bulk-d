import { AnalyzeForm } from "../components/analyze-form";

export default function HomePage() {
  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center space-y-12">
      <div className="space-y-5 text-center">
        <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">
          Bulk<span className="text-gray-400">-D</span>
        </h1>
        <p className="mx-auto max-w-lg text-base text-gray-500 leading-relaxed">
          Paste any media URL. Bulk-D discovers, crawls, and downloads every
          available file automatically.
        </p>
      </div>

      <AnalyzeForm />

      <div className="grid max-w-2xl grid-cols-3 gap-6 text-center text-sm text-gray-500">
        <div className="space-y-2">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-gray-800 bg-white/[0.02]">
            <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          </div>
          <div>Paste URL</div>
        </div>
        <div className="space-y-2">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-gray-800 bg-white/[0.02]">
            <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </div>
          <div>Select episodes</div>
        </div>
        <div className="space-y-2">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-gray-800 bg-white/[0.02]">
            <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </div>
          <div>Download</div>
        </div>
      </div>
    </div>
  );
}
