"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { WaitlistEntry } from "@/lib/types";
import { useT } from "@/components/Language";

/** Classes this customer is queuing for, and any live offer. */
export default function MyWaitlist({ phone }: { phone: string }) {
  const t = useT();
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/my/waitlist", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setEntries(data.entries);
    } catch {
      // Leave whatever is on screen.
    }
  }, []);

  useEffect(() => {
    load();
    // An offer is time-limited, so keep the countdown honest.
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  async function leave(entryId: number) {
    if (!window.confirm(t("wait.leaveConfirm"))) return;
    await fetch("/api/waitlist", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryId, phone }),
    });
    load();
  }

  if (entries.length === 0) return null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="font-semibold">{t("wait.title")}</h2>
      <ul className="mt-3 space-y-3">
        {entries.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-3">
            <div className="min-w-[12rem] flex-1 text-sm">
              <div className="font-medium">{entry.label ?? t("wait.aClass")}</div>
              {entry.participantNames && entry.participantNames.length > 0 && (
                // Who the entry is for, kept from when it was made: an offer is booked for them.
                <div className="text-xs text-slate-600">{t("guard.forLine", { name: entry.participantNames.join(", ") })}</div>
              )}
              <div className="text-xs text-slate-500">
                {entry.status === "offered"
                  ? t("wait.held", {
                      minutes: Math.ceil((entry.expiresInSeconds ?? 0) / 60),
                    })
                  : t("wait.waiting")}
              </div>
            </div>
            {entry.status === "offered" && entry.offerToken ? (
              <Link
                href={`/waitlist/${entry.offerToken}`}
                className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
              >
                {t("wait.claim")}
              </Link>
            ) : (
              <button
                onClick={() => leave(entry.id)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-red-400 hover:text-red-600"
              >
                {t("wait.leave")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
