"use client";

import { useCallback, useEffect, useState } from "react";
import { formatHour } from "@/lib/time";
import type { Court } from "@/lib/types";
import type { RepeatBlock } from "@/lib/repeat-blocks";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Repeating blocks (lib/repeat-blocks.ts): the same hours out every week, set
 * once. Hours already booked are named rather than taken; the rest of a run can
 * be ended at once.
 */
export function RepeatBlockPanel({
  venueId,
  date,
  courts,
  hours,
  onDone,
}: {
  venueId: number;
  date: string;
  courts: Court[];
  hours: number[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [repeats, setRepeats] = useState<RepeatBlock[]>([]);
  const [chosen, setChosen] = useState<number[]>([]);
  const [days, setDays] = useState<number[]>([]);
  const [from, setFrom] = useState(hours[0] ?? 8);
  const [until, setUntil] = useState((hours[0] ?? 8) + 1);
  const [weeks, setWeeks] = useState(12);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/repeat-blocks?venueId=${venueId}`, { cache: "no-store" });
    if (res.ok) setRepeats((await res.json()).repeats);
  }, [venueId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  // The day on the schedule, to start with.
  useEffect(() => setDays([new Date(`${date}T00:00:00Z`).getUTCDay()]), [date]);

  async function save() {
    setError(null);
    setNotice(null);
    const res = await fetch("/api/admin/repeat-blocks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, courtIds: chosen, from: date, days, fromHour: from, untilHour: until, weeks, reason }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error ?? "Could not block those hours");
    const clashes = data.clashes as { courtName: string; date: string; hour: number }[];
    setNotice(
      `Blocked ${data.blocked} court-day${data.blocked === 1 ? "" : "s"}.` +
        (clashes.length > 0
          ? ` Already booked, so left alone: ${clashes
              .slice(0, 6)
              .map((c) => `${c.courtName} ${c.date} ${formatHour(c.hour)}`)
              .join("; ")}${clashes.length > 6 ? ` and ${clashes.length - 6} more` : ""}.`
          : "")
    );
    await load();
    onDone();
  }

  async function end(code: string) {
    if (!confirm("Free the rest of these hours from today?")) return;
    const res = await fetch(`/api/admin/repeat-blocks?venueId=${venueId}&code=${code}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Could not end it");
    else setNotice(`Freed ${data.removed} hour${data.removed === 1 ? "" : "s"}.`);
    await load();
    onDone();
  }

  const select = "rounded-md border border-slate-300 px-2 py-1 text-sm";
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700">
        🔁 Block every week
      </button>
    );
  return (
    <section className="basis-full rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h3 className="font-semibold">Block the same hours every week</h3>
      <p className="mt-1 text-xs text-slate-600">
        For a school&apos;s lessons, cleaning, or the club&apos;s own night. Starts {date}. Hours already booked stay booked and
        are listed for you; customers see the reason on the blocked hours.
      </p>
      <div className="mt-2 flex flex-wrap gap-3">
        {courts.map((c) => (
          <label key={c.id} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={chosen.includes(c.id)}
              onChange={(e) => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((id) => id !== c.id))}
            />
            {c.name}
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {DAYS.map((d, i) => (
          <label key={d} className="flex items-center gap-1">
            <input type="checkbox" checked={days.includes(i)} onChange={(e) => setDays(e.target.checked ? [...days, i] : days.filter((x) => x !== i))} />
            {d}
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        From
        <select aria-label="From" value={from} onChange={(e) => setFrom(Number(e.target.value))} className={select}>
          {hours.map((h) => (
            <option key={h} value={h}>
              {formatHour(h)}
            </option>
          ))}
        </select>
        until
        <select aria-label="Until" value={until} onChange={(e) => setUntil(Number(e.target.value))} className={select}>
          {hours.map((h, i) => {
            const end = hours[i + 1] ?? h + (hours[1] !== undefined ? hours[1] - hours[0] : 1);
            return (
              <option key={h} value={end}>
                {formatHour(end)}
              </option>
            );
          })}
        </select>
        for
        <input aria-label="Weeks" type="number" min={1} max={52} value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} className={`w-16 ${select}`} />
        weeks
        <input placeholder="What for (customers see it)" value={reason} onChange={(e) => setReason(e.target.value)} className={`w-56 ${select}`} />
        <button
          onClick={save}
          disabled={chosen.length === 0 || days.length === 0 || reason.trim().length < 2}
          className="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          Block them
        </button>
        <button onClick={() => setOpen(false)} className="text-xs text-slate-500 underline">
          Close
        </button>
      </div>
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-xs text-emerald-700">{notice}</p>}
      {repeats.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
          {repeats.map((r) => (
            <li key={r.code} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs">
              <span>
                <strong>{r.reason}</strong> · {r.days.map((d) => DAYS[d]).join(", ")} {formatHour(r.fromHour)}–{formatHour(r.untilHour)} ·{" "}
                {r.courts.join(", ")} · next {r.next}, until {r.last}
              </span>
              <button onClick={() => end(r.code)} className="font-medium text-red-700 underline">
                End it
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
