import type { T } from "@/lib/i18n";

/**
 * The private link that takes a waiting-list entry off the list again
 * (/waitlist/leave/[token], lib/store.ts `leaveWaitlistByToken`): shown once
 * the entry is made, and sent with the email saying so.
 */
export default function WaitlistLeaveLink({ t, token }: { t: T; token: string }) {
  return (
    <p className="mt-2 text-xs text-slate-600">
      <a href={`/waitlist/leave/${encodeURIComponent(token)}`} className="font-medium text-teal-700 underline">
        {t("q8b.wl.leaveLink")}
      </a>
    </p>
  );
}
