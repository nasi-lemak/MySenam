"use client";

import { useState } from "react";
import type { ManagedVenue } from "./shared";

/**
 * A customer asking, in person, for what the venue holds about them: a file
 * of everything filed against their phone number here. The account page
 * gives a signed-in customer their own; this is for the rest, a pass or a
 * booking made at the counter, after checking who is asking.
 */
export function DataRequestPanel({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [phone, setPhone] = useState("");
  const input = "rounded-md border border-slate-300 px-3 py-2 text-sm";
  const ready = phone.replace(/\D/g, "").length >= 7;
  return (
    <section>
      <h2 className="text-lg font-bold">A customer&apos;s data</h2>
      <p className="mt-1 text-sm text-slate-500">
        When somebody asks what you hold about them, check who they are first: a phone number is not proof. Then download
        everything here filed against their number, to give them. Managers only; each download goes in the activity log.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {venues.length > 1 && (
          <select aria-label="Venue" value={venueId} onChange={(e) => setVenueId(Number(e.target.value))} className={input}>
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
        <input aria-label="Their phone number" placeholder="Their phone number" value={phone} onChange={(e) => setPhone(e.target.value)} className={input} />
        <a
          aria-disabled={!ready}
          href={ready ? `/api/admin/data-request?venueId=${venueId}&phone=${encodeURIComponent(phone)}` : undefined}
          className={`rounded-md px-3 py-2 text-sm font-semibold text-white ${ready ? "bg-teal-600 hover:bg-teal-700" : "pointer-events-none bg-slate-300"}`}
        >
          Download
        </a>
      </div>
    </section>
  );
}
