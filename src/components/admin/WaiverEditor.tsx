"use client";

import { useEffect, useState } from "react";

/**
 * The venue's waiver (lib/waivers.ts): the words customers agree to before
 * they book. Changing them asks everybody to agree afresh; empty asks for none.
 */
export function WaiverEditor({ venueId }: { venueId: number }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<{ since: string | null; signed: number }>({ since: null, signed: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function take(data: { waiver: { text: string; createdAt: string } | null; signed: number }) {
    setText(data.waiver?.text ?? "");
    setSaved({ since: data.waiver?.createdAt.slice(0, 10) ?? null, signed: data.signed });
  }

  useEffect(() => {
    if (!open) return;
    void fetch(`/api/admin/waiver?venueId=${venueId}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && take(data));
  }, [open, venueId]);

  async function save() {
    if (saved.since && !confirm("Everybody will be asked to agree to the new words before they next book. Save?")) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch("/api/admin/waiver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, text }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setError(data.error ?? "Could not save");
    take(data);
    setNotice(data.waiver ? "Saved. Customers tick the box to agree before they book." : "No waiver: nobody is asked.");
  }

  return (
    <div className="mt-3">
      <button onClick={() => setOpen(!open)} className="text-xs font-medium text-teal-700 underline">
        {open ? "Hide waiver" : "Waiver: what customers agree to before they play"}
      </button>
      {open && (
        <div className="mt-2 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">
            For a climbing wall, a gym floor, kayaks, or any court that wants one. Customers tick a box to agree when they
            book or join a class, once, until you change the words; staff can record one signed on paper from the day&apos;s
            bookings. Have a lawyer read it: MySenam keeps the agreement, not the advice.
          </p>
          {saved.since && (
            <p className="text-xs text-slate-600">
              In force since {saved.since}; {saved.signed} {saved.signed === 1 ? "person has" : "people have"} agreed to it.
            </p>
          )}
          <textarea
            aria-label="Waiver"
            rows={8}
            maxLength={8000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="I take part at my own risk. I am fit to play, I will follow the venue's rules and its staff's instructions, and I will not hold the venue responsible for injury except where it was at fault…"
            className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
          <button disabled={busy} onClick={save} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            Save
          </button>
          {error && <p className="text-sm font-medium text-red-700">{error}</p>}
          {notice && <p className="text-sm font-medium text-emerald-700">{notice}</p>}
        </div>
      )}
    </div>
  );
}
