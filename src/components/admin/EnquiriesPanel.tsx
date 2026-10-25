"use client";

import { useCallback, useEffect, useState } from "react";
import type { Enquiry, EnquiryStatus } from "@/lib/enquiries";
import { internationalNumber } from "@/lib/phone";
import { translator } from "@/lib/i18n";
import type { StaffPhrase } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";

const KIND: Record<Enquiry["kind"], StaffPhrase> = {
  event: "enq.kind.event",
  tournament: "enq.kind.tournament",
  corporate: "enq.kind.corporate",
  party: "enq.kind.party",
  school: "enq.kind.school",
  other: "enq.kind.other",
};

const STATUS: Record<EnquiryStatus, StaffPhrase> = {
  new: "enq.status.new",
  replied: "enq.status.replied",
  booked: "enq.status.booked",
  declined: "enq.status.declined",
};

/**
 * The subject of a reply: in the customer's language where the platform knows
 * it (their account's, or the one they asked in), else the staff member's.
 */
export function replySubject(e: Pick<Enquiry, "replyLocale" | "venueName">, staffSubject: string): string {
  return e.replyLocale ? translator(e.replyLocale)("pre.enquiryReply", { venue: e.venueName }) : staffSubject;
}

/**
 * Private hire enquiries from the venue's page (lib/enquiries.ts): who asked,
 * for what, and a way to answer; then mark where it stands. Shown only when
 * there is one.
 */
export function EnquiriesPanel() {
  const t = useStaffT();
  const [enquiries, setEnquiries] = useState<Enquiry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/enquiries", { cache: "no-store" });
    if (res.ok) setEnquiries((await res.json()).enquiries ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function mark(e: Enquiry, status: EnquiryStatus) {
    setError(null);
    const res = await fetch("/api/admin/enquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId: e.venueId, id: e.id, status }),
    });
    if (!res.ok) setError(t.err(await res.json(), t("enq.saveFailed")));
    await load();
  }

  if (enquiries.length === 0) return null;
  const open = enquiries.filter((e) => e.status === "new").length;
  return (
    <details open={open > 0} className="rounded-xl border border-violet-200 bg-violet-50/50 px-4 py-3 text-sm">
      <summary className="cursor-pointer font-semibold text-violet-900">
        🎉 {t("enq.title")}
        {open > 0 ? ` · ${t("enq.newCount", { n: open })}` : ""}
      </summary>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
      <ul className="mt-2 divide-y divide-violet-100">
        {enquiries.map((e) => {
          return (
            <li key={e.id} className="py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  <strong>{e.name}</strong> · {t(KIND[e.kind])}
                  {e.wantedOn ? ` · ${e.wantedOn}` : ""}
                  {e.people ? ` · ${t("enq.people", { n: e.people })}` : ""}
                  <span className="text-slate-500"> · {e.venueName} · {t("enq.asked", { date: e.createdAt.slice(0, 10) })}</span>
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${e.status === "new" ? "bg-violet-200 text-violet-900" : "bg-slate-100 text-slate-600"}`}>
                  {e.handledBy && e.status !== "new"
                    ? t("enq.statusBy", { status: t(STATUS[e.status]), name: e.handledBy })
                    : t(STATUS[e.status])}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-line text-slate-700">{e.message}</p>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                <a href={`tel:${e.phone}`} className="text-teal-700 underline">
                  📞 {e.phone}
                </a>
                <a href={`https://wa.me/${internationalNumber(e.phone)}`} target="_blank" rel="noreferrer" className="text-teal-700 underline">
                  WhatsApp
                </a>
                {e.email && (
                  <a href={`mailto:${e.email}?subject=${encodeURIComponent(replySubject(e, t("enq.mailSubject")))}`} className="text-teal-700 underline">
                    ✉ {e.email}
                  </a>
                )}
                <span className="text-slate-400">|</span>
                {(["replied", "booked", "declined"] as const)
                  .filter((s) => s !== e.status)
                  .map((s) => (
                    <button key={s} type="button" onClick={() => mark(e, s)} className="font-medium text-violet-800 underline">
                      {t(STATUS[s])}
                    </button>
                  ))}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
