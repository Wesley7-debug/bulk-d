"use client";

import Link from "next/link";

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-black/60 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link
          href="/"
          className="group flex items-center gap-2.5 transition-opacity hover:opacity-90"
        >
          <div className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-white text-[13px] font-bold tracking-tight text-black shadow-lg shadow-black/40 transition-transform duration-300 group-hover:scale-105">
            BD
          </div>
          <span className="text-[15px] font-semibold tracking-tight text-white">
            Bulk<span className="text-gray-400">-D</span>
          </span>
        </Link>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-white/5" />
    </header>
  );
}
