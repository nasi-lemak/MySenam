import Link from "next/link";
import type { Notice } from "@/lib/notices";

/** A notice, as customers see it: one line, and where to read more. */
export function NoticeBar({ notice, more, tone = "teal" }: { notice: Notice; more: string; tone?: "teal" | "light" }) {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl px-4 py-3 text-sm ${
        tone === "light" ? "bg-white/15 text-white" : "border border-teal-200 bg-teal-50 text-teal-900"
      }`}
    >
      <span className="font-medium">📣 {notice.text}</span>
      {notice.link && (
        <Link href={notice.link} className="font-semibold underline">
          {more} →
        </Link>
      )}
    </div>
  );
}
