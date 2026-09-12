import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "MudahTempah — Book Sports Courts Online",
  description:
    "Book badminton, tennis, pickleball and futsal courts across the Klang Valley in seconds.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <Link href="/" className="flex items-center gap-2 text-xl font-bold text-teal-700">
              <span aria-hidden>🏸</span>
              <span>
                Mudah<span className="text-slate-900">Tempah</span>
              </span>
            </Link>
            <nav className="flex items-center gap-4 text-sm font-medium text-slate-600">
              <Link href="/" className="hover:text-teal-700">
                Venues
              </Link>
              <Link href="/my-booking" className="hover:text-teal-700">
                My Booking
              </Link>
              <Link
                href="/admin"
                className="rounded-full border border-slate-300 px-3 py-1 hover:border-teal-600 hover:text-teal-700"
              >
                Admin
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        <footer className="border-t border-slate-200 py-6 text-center text-sm text-slate-500">
          MudahTempah — tempah gelanggang dengan mudah. Built for badminton, tennis, pickleball
          &amp; futsal.
        </footer>
      </body>
    </html>
  );
}
