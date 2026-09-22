"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { WaitlistEntry } from "@/lib/types";

/** Classes this customer is queuing for, and any live offer. */
export default function MyWaitlist({ phone }: { phone: string }) {
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
    if (!window.confirm("Leave this waitlist?")) return;
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
      <h2 className="font-semibold">Waitlist</h2>
      <ul className="mt-3 space-y-3">
        {entries.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-3">
            <div className="min-w-[12rem] flex-1 text-sm">
              <div className="font-medium">{entry.label ?? "Class"}</div>
              <div className="text-xs text-slate-500">
                {entry.status === "offered"
                  ? `A place is being held for you — ${Math.ceil(
                      (entry.expiresInSeconds ?? 0) / 60
                    )} min left`
                  : "Waiting for a place"}
              </div>
            </div>
            {entry.status === "offered" && entry.offerToken ? (
              <Link
                href={`/waitlist/${entry.offerToken}`}
                className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
              >
                Claim place
              </Link>
            ) : (
              <button
                onClick={() => leave(entry.id)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-red-400 hover:text-red-600"
              >
                Leave
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
