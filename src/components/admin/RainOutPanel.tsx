"use client";

import { useEffect, useState } from "react";
import { formatHour } from "@/lib/time";
import type { Court } from "@/lib/types";

/**
 * Rained off (lib/rain-outs.ts): call off every booking and class on the chosen
 * courts for some hours, refund and tell the customers, and block the hours.
 * Outdoor courts are chosen to start with. It says what it will call off first.
 */
export function RainOutPanel({
  venueId,
  date,
  courts,
  hours,
  onDone,
}: {
  venueId: number;
  date: string;
  courts: Court[];
  /** The day's slots, for the hour choices. */
  hours: number[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<number[]>([]);
  const [from, setFrom] = useState(hours[0] ?? 16);
  const [until, setUntil] = useState((hours[hours.length - 1] ?? 22) + 1);
  const [reason, setReason] = useState("Rained off");
  const [preview, setPreview] = useState<{ bookings: { code: string; name: string; startHour: number }[]; classes: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setChosen(courts.filter((c) => c.setting === "outdoor").map((c) => c.id));
    setPreview(null);
  }, [courts, date]);

  async function send(isPreview: boolean) {
    setError(null);
    setNotice(null);
    const res = await fetch("/api/admin/rain-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, courtIds: chosen, date, fromHour: from, untilHour: until, reason, preview: isPreview }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error ?? "Could not do it");
    if (isPreview) return setPreview(data);
    setPreview(null);
    setNotice(
      `Called off ${data.bookings.length} booking${data.bookings.length === 1 ? "" : "s"} and ${data.classes} class${data.classes === 1 ? "" : "es"}; customers are told, and money paid goes back. The hours are blocked.`
    );
    onDone();
  }

  const select = "rounded-md border border-slate-300 px-2 py-1 text-sm";
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-sm font-semibold text-sky-800">
        🌧️ Rained off?
      </button>
    );
  return (
    <section className="rounded-xl border border-sky-200 bg-sky-50/50 p-4 text-sm">
      <h3 className="font-semibold">Rained off on {date}</h3>
      <p className="mt-1 text-xs text-slate-600">
        Calls off every booking and class on these courts in these hours, gives the money back as for any booking you cancel,
        tells each customer, and blocks the hours. A booking already finished is left alone.
      </p>
      <div className="mt-2 flex flex-wrap gap-3">
        {courts.map((c) => (
          <label key={c.id} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={chosen.includes(c.id)}
              onChange={(e) => {
                setPreview(null);
                setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((id) => id !== c.id));
              }}
            />
            {c.name}
            {c.setting === "outdoor" && <span className="text-xs text-slate-500">(outdoor)</span>}
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        From
        <select value={from} onChange={(e) => { setPreview(null); setFrom(Number(e.target.value)); }} className={select}>
          {hours.map((h) => (
            <option key={h} value={h}>
              {formatHour(h)}
            </option>
          ))}
        </select>
        until
        <select value={until} onChange={(e) => { setPreview(null); setUntil(Number(e.target.value)); }} className={select}>
          {hours.map((h) => h + (hours[1] !== undefined ? hours[1] - hours[0] : 1)).map((h) => (
            <option key={h} value={h}>
              {formatHour(h)}
            </option>
          ))}
        </select>
        <input value={reason} onChange={(e) => setReason(e.target.value)} className={`w-40 ${select}`} />
      </div>
      {preview ? (
        <div className="mt-3 rounded-lg bg-white p-3">
          <p>
            This calls off <strong>{preview.bookings.length}</strong> booking{preview.bookings.length === 1 ? "" : "s"}
            {preview.classes > 0 && (
              <>
                {" "}
                and <strong>{preview.classes}</strong> class{preview.classes === 1 ? "" : "es"}
              </>
            )}
            {preview.bookings.length > 0 && `: ${preview.bookings.map((b) => `${formatHour(b.startHour)} ${b.name}`).join(", ")}`}.
          </p>
          <div className="mt-2 flex gap-2">
            <button onClick={() => void send(false)} className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white">
              Call them off
            </button>
            <button onClick={() => setPreview(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">
              Not yet
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button disabled={chosen.length === 0} onClick={() => void send(true)} className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            See what it calls off
          </button>
          <button onClick={() => setOpen(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">
            Close
          </button>
        </div>
      )}
      {notice && <p className="mt-2 font-medium text-emerald-700">{notice}</p>}
      {error && <p className="mt-2 font-medium text-red-700">{error}</p>}
    </section>
  );
}
