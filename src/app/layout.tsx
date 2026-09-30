import type { Metadata } from "next";
import Link from "next/link";
import AuthNav from "@/components/AuthNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "MySenam — Book Courts, Gyms & Classes Online",
  description:
    "Book badminton, tennis, pickleball and futsal courts, gym sessions and classes across the Klang Valley in seconds.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-y-2 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 text-xl font-bold text-teal-700">
              <span aria-hidden>🏸</span>
              <span>
                My<span className="text-slate-900">Senam</span>
              </span>
            </Link>
            {/* Wraps to a second line on a phone rather than pushing the page sideways. */}
            <nav className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 text-sm font-medium text-slate-600">
              <Link href="/" className="hover:text-teal-700">
                Venues
              </Link>
              <Link href="/search" className="hover:text-teal-700">
                Find a court
              </Link>
              <Link href="/classes" className="hover:text-teal-700">
                Classes
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
              <AuthNav />
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        <footer className="border-t border-slate-200 py-6 text-center text-sm text-slate-500">
          <p>
            MySenam — gelanggang, gim dan kelas, satu tempahan. Built for badminton, tennis,
            pickleball, futsal, gym &amp; swimming.
          </p>
          <p className="mt-1.5">
            <Link href="/privacy" className="hover:text-teal-700 hover:underline">
              Privacy notice
            </Link>
          </p>
        </footer>
      </body>
    </html>
  );
}
