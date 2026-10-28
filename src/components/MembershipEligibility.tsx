"use client";

import Link from "next/link";
import { useT } from "@/components/Language";
import type { MemberLapse } from "@/lib/entitlements";

/** One person taking a place on a members' session, as the quote says (app/api/quote). */
export interface MemberLine {
  /** Null: the signed-in customer's own place. */
  participantId: number | null;
  name: string;
  covered: boolean;
  lapse?: MemberLapse;
  /** Where to renew or buy online; "" where the venue renews at the counter. */
  renew: string;
}

/**
 * Whether each person taking a place on a members-only session is a member
 * on its date (lib/entitlements.ts `memberCover`), shown before booking. A
 * membership that is live today but ends before the session does not count:
 * it says so, with the date it ends, and where to renew (the venue's plans,
 * or the counter). The booking asks the same, and refuses with the same
 * reason.
 */
export default function MembershipEligibility({ lines, date }: { lines: MemberLine[]; date: string }) {
  const t = useT();
  if (lines.length === 0) return null;
  const short = lines.filter((l) => !l.covered);
  const renew = short.find((l) => l.renew !== "")?.renew ?? null;
  const says = (l: MemberLine): string => {
    const self = l.participantId === null;
    if (l.covered) return self ? t("mv6.coveredSelf", { date }) : t("mv6.covered", { name: l.name, date });
    if (l.lapse?.kind === "ended") return self ? t("mv6.endedSelf", { until: l.lapse.until, date }) : t("mv6.ended", { name: l.name, until: l.lapse.until, date });
    if (l.lapse?.kind === "cancelled") return self ? t("mv6.cancelledSelf") : t("mv6.cancelled", { name: l.name });
    if (l.lapse?.kind === "suspended") return self ? t("ms7.suspendedSelf", { date }) : t("ms7.suspended", { name: l.name, date });
    return self ? t("mv6.noneSelf", { date }) : t("mv6.none", { name: l.name, date });
  };
  return (
    <div
      role={short.length > 0 ? "alert" : "status"}
      className={`mt-2 rounded-lg border px-3 py-2 text-xs ${short.length > 0 ? "border-amber-300 bg-amber-50 text-amber-900" : "border-teal-200 bg-teal-50 text-teal-900"}`}
    >
      <div className="font-semibold">{t("mv6.title", { date })}</div>
      <ul className="mt-0.5 space-y-0.5">
        {lines.map((l) => (
          <li key={l.participantId ?? "self"} data-covered={l.covered ? "yes" : "no"}>
            {l.covered ? "✓ " : "✗ "}
            {says(l)}
          </li>
        ))}
      </ul>
      {short.length > 0 &&
        (renew ? (
          <Link href={renew} className="mt-1 inline-block font-semibold underline">
            {t("mv6.renew")}
          </Link>
        ) : (
          <p className="mt-1">{t("mv6.askVenue")}</p>
        ))}
    </div>
  );
}
