"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import PayOnline from "@/components/PayOnline";
import BookingTermsNotice from "@/components/BookingTermsNotice";
import { sportLabel, translateError } from "@/lib/i18n";
import { money } from "@/lib/region";
import { formatHour, slotsBetween } from "@/lib/time";
import type { Booking, Sport } from "@/lib/types";

/** A day, a free time with the coach, a length, and who is coming: then a lesson booked. */
export default function CoachBooking({
  venueId,
  coach,
  dates,
  step,
  payOnline,
}: {
  venueId: number;
  coach: { id: number; name: string; sports: Sport[] };
  dates: string[];
  step: number;
  payOnline: boolean;
}) {
  const t = useT();
  const [sport, setSport] = useState<Sport>(coach.sports[0]);
  const [date, setDate] = useState(dates[0]);
  const [slots, setSlots] = useState<number[] | null>(null);
  const [start, setStart] = useState<number | null>(null);
  const [length, setLength] = useState(1);
  const [who, setWho] = useState({ name: "", phone: "", email: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<Booking | null>(null);

  useEffect(() => {
    void fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { user?: { name: string; phone: string; email: string } }) => {
        if (d.user) setWho({ name: d.user.name, phone: d.user.phone, email: d.user.email });
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setSlots(null);
    setStart(null);
    void fetch(`/api/coaching/slots?coachId=${coach.id}&date=${date}&sport=${sport}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { slots?: number[] }) => setSlots(d.slots ?? []));
  }, [coach.id, date, sport]);

  // Lengths that fit from the chosen start, every slot of them free.
  const lengths = (step === 0.5 ? [0.5, 1, 1.5, 2] : [1, 2]).filter(
    (len) => start !== null && slotsBetween(start, start + len, step).every((h) => slots?.includes(h))
  );
  const hours = start !== null && lengths.includes(length) ? slotsBetween(start, start + length, step) : [];

  async function book(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, sport, date, hours, coachId: coach.id, ...who }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("pay.failed"));
      setBooked(data.booking);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pay.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (booked)
    return (
      <div className="mt-4 space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
        <p className="font-semibold">{t("coach.booked", { code: booked.code })}</p>
        <p>
          {booked.date} {formatHour(booked.startHour)}–{formatHour(booked.endHour)} · {t("coach.with", { name: coach.name })} ·{" "}
          {money(booked.totalPrice)}
        </p>
        {payOnline && booked.paymentStatus === "unpaid" && booked.totalPrice > 0 && (
          <PayOnline codes={[booked.code]} phone={booked.phone} amount={booked.totalPrice} held={!!booked.holdUntil} />
        )}
        <Link href="/my-booking" className="inline-block font-medium text-teal-800 underline">
          {t("nav.myBooking")}
        </Link>
      </div>
    );

  const input = "mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm";
  const pill = (on: boolean) =>
    `rounded-lg border px-3 py-1.5 text-sm font-medium ${on ? "border-teal-600 bg-teal-600 text-white" : "border-slate-300 text-slate-700 hover:border-teal-500"}`;
  return (
    <form onSubmit={book} className="mt-4 space-y-4">
      {coach.sports.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {coach.sports.map((s) => (
            <button type="button" key={s} onClick={() => setSport(s)} className={pill(s === sport)}>
              {sportLabel(t, s)}
            </button>
          ))}
        </div>
      )}
      <label className="block text-sm font-medium text-slate-700">
        {t("coach.pickDay")}
        <select value={date} onChange={(e) => setDate(e.target.value)} className={input}>
          {dates.map((d) => (
            <option key={d} value={d}>
              {new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}
            </option>
          ))}
        </select>
      </label>
      <div>
        <p className="text-sm font-medium text-slate-700">{t("coach.pickTime")}</p>
        {slots === null ? (
          <p className="mt-1 text-sm text-slate-400">…</p>
        ) : slots.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">{t("coach.none", { name: coach.name })}</p>
        ) : (
          <div className="mt-1 flex flex-wrap gap-2">
            {slots.map((h) => (
              <button type="button" key={h} onClick={() => setStart(h)} className={pill(h === start)}>
                {formatHour(h)}
              </button>
            ))}
          </div>
        )}
      </div>
      {start !== null && (
        <div>
          <p className="text-sm font-medium text-slate-700">{t("coach.length")}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {lengths.map((len) => (
              <button type="button" key={len} onClick={() => setLength(len)} className={pill(len === length)}>
                {t("coach.minutes", { n: len * 60 })}
              </button>
            ))}
          </div>
        </div>
      )}
      {hours.length > 0 && (
        <>
          <input aria-label={t("form.name")} placeholder={t("form.name")} required minLength={2} value={who.name} onChange={(e) => setWho({ ...who, name: e.target.value })} className={input} />
          <input aria-label={t("form.phone")} placeholder={t("form.phone")} required type="tel" value={who.phone} onChange={(e) => setWho({ ...who, phone: e.target.value })} className={input} />
          <input aria-label={t("form.emailOptional")} placeholder={t("form.emailOptional")} type="email" value={who.email} onChange={(e) => setWho({ ...who, email: e.target.value })} className={input} />
          <BookingTermsNotice venueId={venueId} />
          <p className="text-xs text-slate-500">{t("coach.terms")}</p>
          {error && <p className="text-sm font-medium text-red-700">{error}</p>}
          <button disabled={busy} className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
            {t("coach.confirm", { length: t("coach.minutes", { n: length * 60 }), name: coach.name, time: formatHour(start!) })}
          </button>
        </>
      )}
    </form>
  );
}
