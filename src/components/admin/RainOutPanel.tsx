"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { formatHour } from "@/lib/time";
import type { Court } from "@/lib/types";
import { useStaffT } from "./StaffLanguage";

/** A phrase with elements in it: each `{name}` becomes the element given for it. */
function rich(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((piece, i) => (i % 2 ? <Fragment key={i}>{parts[piece] ?? `{${piece}}`}</Fragment> : piece));
}

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
  const t = useStaffT();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<number[]>([]);
  const [from, setFrom] = useState(hours[0] ?? 16);
  const [until, setUntil] = useState((hours[hours.length - 1] ?? 22) + 1);
  // null: the built-in reason, untouched, which each customer reads in their
  // own language; once staff type, their words go to everybody as typed.
  const [typed, setTyped] = useState<string | null>(null);
  const reason = typed ?? t("rain.defaultReason");
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
      body: JSON.stringify({
        venueId,
        courtIds: chosen,
        date,
        fromHour: from,
        untilHour: until,
        reason,
        ...(typed === null || ["", t("rain.defaultReason")].includes(typed.trim()) ? { reasonPreset: "rained_off" } : {}),
        preview: isPreview,
      }),
    });
    const data = await res.json();
    if (!res.ok) return setError(t.err(data, t("rain.failed")));
    if (isPreview) return setPreview(data);
    setPreview(null);
    setNotice(
      t("rain.done", { bookings: t.plural("rain.bookings", data.bookings.length), classes: t.plural("rain.classes", data.classes) })
    );
    onDone();
  }

  const select = "rounded-md border border-slate-300 px-2 py-1 text-sm";
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-sm font-semibold text-sky-800">
        🌧️ {t("rain.open")}
      </button>
    );
  return (
    <section className="basis-full rounded-xl border border-sky-200 bg-sky-50/50 p-4 text-sm">
      <h3 className="font-semibold">{t("rain.title", { date })}</h3>
      <p className="mt-1 text-xs text-slate-600">{t("rain.intro")}</p>
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
            {c.setting === "outdoor" && <span className="text-xs text-slate-500">{t("rain.outdoor")}</span>}
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {rich(t("rain.range"), {
          from: (
            <select value={from} onChange={(e) => { setPreview(null); setFrom(Number(e.target.value)); }} className={select}>
              {hours.map((h) => (
                <option key={h} value={h}>
                  {formatHour(h, t.locale)}
                </option>
              ))}
            </select>
          ),
          until: (
            <select value={until} onChange={(e) => { setPreview(null); setUntil(Number(e.target.value)); }} className={select}>
              {hours.map((h) => h + (hours[1] !== undefined ? hours[1] - hours[0] : 1)).map((h) => (
                <option key={h} value={h}>
                  {formatHour(h, t.locale)}
                </option>
              ))}
            </select>
          ),
        })}
        <input value={reason} onChange={(e) => setTyped(e.target.value)} className={`w-40 ${select}`} />
      </div>
      {preview ? (
        <div className="mt-3 rounded-lg bg-white p-3">
          <p>
            {rich(
              t(
                preview.classes > 0
                  ? preview.bookings.length > 0
                    ? "rain.previewClassesList"
                    : "rain.previewClasses"
                  : preview.bookings.length > 0
                    ? "rain.previewList"
                    : "rain.preview",
                { list: preview.bookings.map((b) => `${formatHour(b.startHour, t.locale)} ${b.name}`).join(", ") }
              ),
              {
                // The counts in bold: the phrase for each, with its number left to put in.
                bookings: rich(t.plural("rain.bookings", preview.bookings.length, { n: "{n}" }), {
                  n: <strong>{preview.bookings.length}</strong>,
                }),
                classes: rich(t.plural("rain.classes", preview.classes, { n: "{n}" }), { n: <strong>{preview.classes}</strong> }),
              }
            )}
          </p>
          <div className="mt-2 flex gap-2">
            <button onClick={() => void send(false)} className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white">
              {t("rain.callOff")}
            </button>
            <button onClick={() => setPreview(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">
              {t("rain.notYet")}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button disabled={chosen.length === 0} onClick={() => void send(true)} className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {t("rain.see")}
          </button>
          <button onClick={() => setOpen(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">
            {t("c.close")}
          </button>
        </div>
      )}
      {notice && <p className="mt-2 font-medium text-emerald-700">{notice}</p>}
      {error && <p className="mt-2 font-medium text-red-700">{error}</p>}
    </section>
  );
}
