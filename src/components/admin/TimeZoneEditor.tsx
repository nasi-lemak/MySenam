"use client";

import { useEffect, useState } from "react";
import type { ZoneSettings } from "@/lib/zones";

/**
 * Which time zone a venue's courts keep. Worked out from its map pin unless a
 * manager picks one; only shown where the country has more than one.
 */
export function TimeZoneEditor({ venueId }: { venueId: number }) {
  const [settings, setSettings] = useState<ZoneSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSettings(null);
    void fetch(`/api/admin/venue-time-zone?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { settings?: ZoneSettings }) => setSettings(d.settings ?? null));
  }, [venueId]);

  async function choose(zone: string | null) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/venue-time-zone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, zone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      setSettings(data.settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (!settings || settings.options.length < 2) return null;
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h3 className="font-semibold">Time zone</h3>
      <p className="mt-1 text-xs text-slate-500">
        The clock this venue&apos;s courts run on: when a slot has passed, when reminders go, what calendars show. Worked
        out from the map pin; pick one only if that is wrong. Bookings keep their times (18:00 stays 18:00).
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label="Time zone"
          disabled={busy}
          value={settings.chosen ? settings.zone : ""}
          onChange={(e) => choose(e.target.value || null)}
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
        >
          <option value="">From the map pin ({settings.fromPin})</option>
          {settings.options.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <span className="text-xs text-slate-500">In force: {settings.zone}</span>
      </div>
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}
