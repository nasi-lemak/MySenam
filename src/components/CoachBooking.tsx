"use client";

import { useManagedPeople, WhoTakesPart, whoBody } from "@/components/WhoTakesPart";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import PayOnline from "@/components/PayOnline";
import BookingTermsNotice from "@/components/BookingTermsNotice";
import { sportLabel, translateError } from "@/lib/i18n";
import { localTimeOf, money } from "@/lib/region";
import { formatMinute } from "@/lib/interval";
import { lengthsUpTo } from "@/lib/booking-rules";
import { MAX_RECUR_WEEKS, type Booking, type PublicPolicy, type Sport, type StartOption } from "@/lib/types";

/**
 * A day, a free time with the coach, a length, and who is coming: then a
 * lesson booked. With no coach named (`coach.id` null), at a venue that
 * assigns the coach (lib/lesson-coaches.ts): the times any of its coaches of
 * the sport is free, and the coach given is shown on the confirmation.
 */
export default function CoachBooking({
  venueId,
  coach,
  dates,
  payOnline,
  timeZone,
}: {
  venueId: number;
  coach: { id: number | null; name: string; sports: Sport[] };
  dates: string[];
  payOnline: boolean;
  timeZone: string;
}) {
  const t = useT();
  const [sport, setSport] = useState<Sport>(coach.sports[0]);
  // The venue assigns the coach: who it gave, once booked.
  const assigns = coach.id === null;
  const [given, setGiven] = useState<string | null>(null);
  const [date, setDate] = useState(dates[0]);
  // Where a lesson can start that day, and the longest from each; the sport's lengths here.
  const [starts, setStarts] = useState<StartOption[] | null>(null);
  const [policy, setPolicy] = useState<PublicPolicy | null>(null);
  const [start, setStart] = useState<number | null>(null);
  const [length, setLength] = useState(60);
  const [who, setWho] = useState({ name: "", phone: "", email: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<Booking | null>(null);
  // Every lesson booked, one or several weeks of them, and how long they are held unpaid.
  const [all, setAll] = useState<Booking[]>([]);
  const [holdUntil, setHoldUntil] = useState<string | null>(null);
  const [depositPercent, setDepositPercent] = useState<number | null>(null);
  // Weekly lessons, for a signed-in customer, like a weekly court.
  const [signedIn, setSignedIn] = useState(false);
  const [weeks, setWeeks] = useState(1);
  const [series, setSeries] = useState<{ count: number; skipped: { date: string; reason: string }[] } | null>(null);
  // A lesson for somebody the adult manages: the coach teaches them, the adult is told and pays (lib/participant-bookings.ts).
  const people = useManagedPeople(signedIn);
  const [forIds, setForIds] = useState<number[]>([]);
  const [meToo, setMeToo] = useState(true);

  useEffect(() => {
    void fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { user?: { name: string; phone: string; email: string } }) => {
        if (d.user) {
          setWho({ name: d.user.name, phone: d.user.phone, email: d.user.email });
          setSignedIn(true);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setStarts(null);
    setStart(null);
    void fetch(assigns ? `/api/coaching/slots?venueId=${venueId}&date=${date}&sport=${sport}` : `/api/coaching/slots?coachId=${coach.id}&date=${date}&sport=${sport}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { starts?: StartOption[]; policy?: PublicPolicy }) => {
        setPolicy(d.policy ?? null);
        setStarts(d.starts ?? []);
      });
  }, [assigns, venueId, coach.id, date, sport]);

  // Lengths the courts allow that fit from the chosen start, the coach free throughout.
  const option = starts?.find((s) => s.minute === start);
  const lengths = option && policy ? lengthsUpTo(policy, option.maxLength) : [];
  const ready = start !== null && lengths.includes(length);

  async function book(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, sport, date, start, minutes: length, ...(assigns ? { assignCoach: true } : { coachId: coach.id }), ...who, ...whoBody(forIds, meToo), weeks, skipConflicts: weeks > 1 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("pay.failed"));
      setGiven(data.lessonCoach?.name ?? null);
      setBooked(data.booking);
      setAll(data.bookings ?? [data.booking]);
      setHoldUntil(data.holdUntil ?? null);
      setDepositPercent(data.depositPercent ?? null);
      if (weeks > 1) setSeries({ count: data.bookings?.length ?? 1, skipped: data.skipped ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pay.failed"));
    } finally {
      setBusy(false);
    }
  }

  // A weekly run is paid for in one go, like weekly courts.
  const total = Math.round(all.reduce((sum, b) => sum + b.totalPrice, 0) * 100) / 100;
  const unpaid = all.filter((b) => b.paymentStatus === "unpaid" && b.totalPrice > 0);
  const unpaidTotal = Math.round(unpaid.reduce((sum, b) => sum + b.totalPrice, 0) * 100) / 100;

  if (booked)
    return (
      <div className="mt-4 space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
        <p className="font-semibold">{t("coach.booked", { code: booked.code })}</p>
        {series && (
          <p>
            {t("coach.weeksBooked", { n: series.count })}
            {series.skipped.map((s) => (
              <span key={s.date} className="block text-amber-800">
                {t("coach.weekSkipped", { date: s.date, reason: s.reason })}
              </span>
            ))}
          </p>
        )}
        <p>
          {booked.date} {formatMinute(booked.startMin, t.locale)}–{formatMinute(booked.endMin, t.locale)} ·{" "}
          {assigns ? t("co6.yourCoach", { name: given ?? "" }) : t("coach.with", { name: coach.name })} ·{" "}
          {money(booked.totalPrice)}
          {all.length > 1 && <> · {t("done.total")} {money(total)}</>}
        </p>
        {holdUntil && unpaid.length > 0 && (
          <p className="font-medium text-amber-800">{t("hold.body", { time: localTimeOf(holdUntil, timeZone, t.locale) })}</p>
        )}
        {payOnline && unpaid.length > 0 && (
          <PayOnline codes={unpaid.map((b) => b.code)} phone={booked.phone} amount={unpaidTotal} held={!!holdUntil} depositPercent={depositPercent} />
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
        {starts === null ? (
          <p className="mt-1 text-sm text-slate-400">…</p>
        ) : starts.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">{assigns ? t("co6.noneFree") : t("coach.none", { name: coach.name })}</p>
        ) : (
          <div className="mt-1 flex flex-wrap gap-2">
            {starts.map((s) => (
              <button
                type="button"
                key={s.minute}
                onClick={() => {
                  setStart(s.minute);
                  // The courts' usual length where it fits, else the longest that does.
                  const fits = policy ? lengthsUpTo(policy, s.maxLength) : [];
                  if (!fits.includes(length)) setLength(policy && fits.includes(policy.defaultLength) ? policy.defaultLength : (fits[fits.length - 1] ?? length));
                }}
                className={pill(s.minute === start)}
              >
                {formatMinute(s.minute, t.locale)}
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
                {t("coach.minutes", { n: len })}
              </button>
            ))}
          </div>
        </div>
      )}
      {ready && (
        <>
          <input aria-label={t("form.name")} placeholder={t("form.name")} required minLength={2} value={who.name} onChange={(e) => setWho({ ...who, name: e.target.value })} className={input} />
          <input aria-label={t("form.phone")} placeholder={t("form.phone")} required type="tel" value={who.phone} onChange={(e) => setWho({ ...who, phone: e.target.value })} className={input} />
          <input aria-label={t("form.emailOptional")} placeholder={t("form.emailOptional")} type="email" value={who.email} onChange={(e) => setWho({ ...who, email: e.target.value })} className={input} />
          {signedIn ? (
            <label className="block text-sm font-medium text-slate-700">
              {t("form.repeat")}
              <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} className={input}>
                <option value={1}>{t("form.justOnce")}</option>
                {Array.from({ length: MAX_RECUR_WEEKS - 1 }, (_, i) => i + 2).map((w) => (
                  <option key={w} value={w}>
                    {t("form.weekly", { n: w })}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-xs text-slate-500">{t("err.SERIES_NEEDS_ACCOUNT")}</p>
          )}
          <WhoTakesPart
            t={t}
            people={people}
            ids={forIds}
            meToo={meToo}
            onChange={(ids, me) => {
              setForIds(ids);
              setMeToo(me);
            }}
          />
          <BookingTermsNotice venueId={venueId} sport={sport} />
          <p className="text-xs text-slate-500">{t("coach.terms")}</p>
          {error && <p className="text-sm font-medium text-red-700">{error}</p>}
          <button disabled={busy} className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
            {assigns
              ? t("co6.confirm", { length: t("coach.minutes", { n: length }), time: formatMinute(start!, t.locale) })
              : t("coach.confirm", { length: t("coach.minutes", { n: length }), name: coach.name, time: formatMinute(start!, t.locale) })}
          </button>
        </>
      )}
    </form>
  );
}
