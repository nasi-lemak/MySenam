"use client";

import { useCallback, useEffect, useState } from "react";
import type { ManagedVenue } from "./shared";

interface Blocked {
  phone: string;
  reason: string | null;
  createdAt: string;
}

/**
 * Numbers a venue does not take online bookings from.
 *
 * For the person who books every evening and never comes, or fills a night
 * with names that do not exist. They can still ring the venue; they just
 * cannot hold its courts from a phone without anybody speaking to them.
 */
export function BlockedPhonesPanel({ venues }: { venues: ManagedVenue[] }) {
  return (
    <section>
      <h2 className="text-lg font-bold">Blocked numbers</h2>
      <p className="mt-1 text-sm text-slate-500">
        Phone numbers that cannot book or join a waitlist here online. Staff can still book them at the counter.
        Block one from its booking with <em>Block number</em>, or here.
      </p>
      <div className="mt-3 space-y-3">
        {venues.map((venue) => (
          <VenueBlocks key={venue.id} venue={venue} />
        ))}
      </div>
    </section>
  );
}

function VenueBlocks({ venue }: { venue: ManagedVenue }) {
  const [blocked, setBlocked] = useState<Blocked[]>([]);
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const url = `/api/admin/venues/${venue.id}/blocked-phones`;

  const load = useCallback(async () => {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) setBlocked((await res.json()).blocked);
  }, [url]);
  useEffect(() => {
    void load();
  }, [load]);

  async function send(method: "POST" | "DELETE", body: object) {
    setError(null);
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) return setError(data.error ?? "That did not work.");
    setBlocked(data.blocked);
    if (method === "POST") {
      setPhone("");
      setReason("");
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="font-semibold">{venue.name}</div>
      {blocked.length === 0 ? (
        <p className="mt-1 text-sm text-slate-500">No numbers blocked.</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {blocked.map((b) => (
            <li key={b.phone} className="flex items-center justify-between gap-3 py-1.5">
              <span>
                <span className="font-medium">{b.phone}</span>
                {b.reason && <span className="ml-2 text-slate-500">{b.reason}</span>}
              </span>
              <button
                onClick={() => send("DELETE", { phone: b.phone })}
                className="text-xs text-slate-500 underline hover:text-teal-700"
              >
                Unblock
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send("POST", { phone, reason });
        }}
      >
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="012-345 6789"
          aria-label="Phone number to block"
          className="w-40 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          required
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why (only staff see it)"
          aria-label="Reason"
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        <button className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-900">
          Block
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
