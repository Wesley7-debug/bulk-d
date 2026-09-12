"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { Button } from "./ui/button";

export function Header() {
  const { data: session } = useSession();

  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-black/60 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        {/* Brand */}
        <Link
          href="/"
          className="group flex items-center gap-2.5 transition-opacity hover:opacity-90"
        >
          <div className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-white text-[13px] font-bold tracking-tight text-black shadow-lg shadow-black/40 transition-transform duration-300 group-hover:scale-105">
            BF
          </div>
          <span className="text-[15px] font-semibold tracking-tight text-white">
            Bulk<span className="text-gray-500">Forge</span>
          </span>
        </Link>

        {/* Nav */}
        <nav className="flex items-center gap-2 sm:gap-3">
          {session ? (
            <>
              <Link href="/dashboard">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-gray-300 hover:bg-white/5 hover:text-white"
                >
                  Dashboard
                </Button>
              </Link>

              <div className="hidden h-8 items-center gap-2.5 rounded-full border border-white/10 bg-white/[0.03] pl-1 pr-3 sm:flex">
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-[10px] font-semibold uppercase text-gray-200">
                  {(session.user?.name || session.user?.email || "U")
                    .charAt(0)
                    .toUpperCase()}
                </div>
                <span className="max-w-[140px] truncate text-xs font-medium text-gray-300">
                  {session.user?.name || session.user?.email}
                </span>
              </div>
            </>
          ) : (
            <Link href="/login">
              <Button
                size="sm"
                className="h-9 rounded-lg bg-white px-4 text-sm font-semibold text-black transition-colors hover:bg-gray-100"
              >
                Sign In
              </Button>
            </Link>
          )}
        </nav>
      </div>

      {/* Bottom hairline highlight */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-white/5" />
    </header>
  );
}
