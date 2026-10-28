"use client";

import { activityIcon } from "@/lib/activity-registry";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { formatHour, hoursUntilSlot, todayISO } from "@/lib/time";

import type { User } from "@/lib/auth";
import type { PhoneStatus } from "@/lib/phone-check";
import type { UserBookingRow } from "@/lib/store";
import { downloadIcs, googleCalendarUrl, whatsappShareUrl } from "@/lib/booking-links";
import CheckInQr from "@/components/CheckInQr";
import Wallet from "@/components/Wallet";
import MyWaitlist from "@/components/MyWaitlist";
import MyPasses from "@/components/MyPasses";
import MyMemberships from "@/components/MyMemberships";
import MyReceipts from "@/components/MyReceipts";
import { ChangePassword } from "@/components/ChangePassword";
import { BookAgain } from "@/components/BookAgain";
import { MyVenues } from "@/components/MyVenues";
import { GuestInvites } from "@/components/GuestInvites";
import ManagedPeople from "@/components/ManagedPeople";
import { useT } from "@/components/Language";
import { SeriesCancel } from "@/components/SeriesCancel";
import { WithdrawPeople } from "@/components/WithdrawPeople";
import { translateError } from "@/lib/i18n";
import { refundLines, refundStatusLine } from "@/lib/refund-text";
import type { RefundStatus } from "@/lib/payments";
import type { T } from "@/lib/i18n";
import { money } from "@/lib/region";

export default function AccountPage() {
  const router = useRouter();
  const t = useT();
  const [user, setUser] = useState<User | null>(null);
  const [phone, setPhone] = useState<PhoneStatus | null>(null);
  const [gender, setGender] = useState<string | null>(null);
  const [bookings, setBookings] = useState<UserBookingRow[] | null>(null);
  const [refunds, setRefunds] = useState<RefundStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const meRes = await fetch("/api/auth/me", { cache: "no-store" });
      const me = await meRes.json();
      if (!me.user) {
        router.replace("/login");
        return;
      }
      setUser(me.user);
      setPhone(me.phone ?? null);
      setGender(me.gender ?? null);
      const res = await fetch("/api/my/bookings", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("acct.loadFailed"));
      setBookings(data.bookings);
      setRefunds(data.refunds ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("acct.loadFailed"));
    } finally {
      setLoaded(true);
    }
  }, [router, t]);

  useEffect(() => {
    load();
  }, [load]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  /** The series whose weeks are being chosen to cancel (components/SeriesCancel.tsx). */
  const [seriesOpen, setSeriesOpen] = useState<string | null>(null);
  function cancelSeries(seriesCode: string) {
    setError(null);
    setSeriesOpen(seriesCode);
  }


  async function cancel(b: UserBookingRow) {
    const keep = b.venueLateCancelKeep;
    const late = keep !== null && hoursUntilSlot(b.date, b.startHour, b.venueTimeZone) < b.venueCancelCutoffHours;
    const askLate = late && keep > 0 && b.paymentStatus === "paid" && b.totalPrice > 0;
    // Late and unpaid: no fee, but a strike against the number, where the venue counts them.
    const strike = late && b.paymentStatus !== "paid" && b.venueStrikeLimit !== null;
    if (
      !window.confirm(
        askLate ? t("mine.lateCancelConfirm", { pct: keep }) : strike ? t("mine.lateStrikeConfirm") : t("mine.cancelConfirm")
      )
    )
      return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/my/bookings/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: b.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("mine.cancelFailed"));
      const lines = [...(data.kept > 0 ? [t("mine.lateCancelDone", { kept: money(data.kept) })] : []), ...refundLines(t, data.refunds)];
      setNotice(lines.length > 0 ? lines.join(" ") : null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mine.cancelFailed"));
    }
  }

  if (!loaded || !user) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
        {t("classes.loading")}
      </div>
    );
  }

  const today = todayISO();
  const upcoming = (bookings ?? []).filter((b) => b.status === "confirmed" && b.date >= today);
  const past = (bookings ?? []).filter((b) => b.status !== "confirmed" || b.date < today);
  // What they usually play: the latest few distinct court-and-time pairs they
  // turned up for, newest first.
  const regulars = past
    .filter((b) => b.status === "confirmed" && b.classId === null)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .filter((b, i, all) => all.findIndex((x) => x.courtId === b.courtId && x.startHour === b.startHour && x.endHour === b.endHour) === i)
    .slice(0, 3);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("acct.greeting", { name: user.name })}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {user.email}
            {" · "}
            {user.phone ? (
              <>
                {user.phone}{" "}
                {phone?.verified ? (
                  <span className="text-emerald-700">✓ {t("phone.checked")}</span>
                ) : phone?.checks ? (
                  <Link href="/account/phone" className="font-medium text-teal-700 underline">
                    {t("phone.checkIt")}
                  </Link>
                ) : null}
              </>
            ) : (
              <Link href="/account/phone" className="font-medium text-teal-700 underline">
                {t("phone.add")}
              </Link>
            )}
            {gender && (
              <>
                {" · "}
                {t("about.label")}: {t(`about.${gender as "woman" | "man" | "unsaid"}`)}{" "}
                <Link href="/account/about" className="text-teal-700 underline">
                  {t("about.change")}
                </Link>
              </>
            )}
          </p>
        </div>
        <button
          onClick={logout}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:border-teal-600 hover:text-teal-700"
        >
          {t("acct.signOut")}
        </button>
      </div>

      <ChangePassword endpoint="/api/my/password" />

      <MyVenues />
      <Link href="/account/approvals" className="block rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-teal-700 shadow-sm hover:bg-slate-50">
        {t("apr.accountLink")} →
      </Link>
      <ManagedPeople />
      <GuestInvites />

      {regulars.length > 0 && (
        <section>
          <h2 className="text-lg font-bold">{t("again.title")}</h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-3">
            {regulars.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                <div className="min-w-0 text-sm">
                  <p className="truncate font-semibold">
                    {activityIcon(b.sport)} {b.venueName}
                  </p>
                  <p className="truncate text-slate-600">
                    {b.courtName} · {formatHour(b.startHour, t.locale)}–{formatHour(b.endHour, t.locale)}
                  </p>
                </div>
                <BookAgain code={b.code} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">{notice}</div>
      )}

      <Wallet />

      <MyPasses />

      <MyMemberships />

      <MyReceipts />

      <MyWaitlist phone={user.phone} />

      <section>
        {refunds.length > 0 && (
          <div className="mb-6">
            <h2 className="text-lg font-bold">{t("refund.title")}</h2>
            <ul className="mt-3 space-y-2">
              {refunds.map((r) => {
                const line = refundStatusLine(t, r);
                const codes = (bookings ?? []).filter((b) => r.bookingIds.includes(b.id)).map((b) => b.code);
                return (
                  <li
                    key={r.paymentId}
                    className={`rounded-lg border px-3 py-2 text-sm ${line.late ? "border-amber-300 bg-amber-50 text-amber-900" : "border-slate-200 bg-white text-slate-700"}`}
                  >
                    {codes.length > 0 && <span className="mr-2 font-mono text-xs text-slate-500">{t("refund.forBooking", { code: codes.join(", ") })}</span>}
                    {line.text}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <h2 className="text-lg font-bold">{t("acct.upcoming")}</h2>
        {seriesOpen && (
          <div className="mt-3">
            <SeriesCancel
              key={seriesOpen}
              t={t}
              seriesCode={seriesOpen}
              phone={user.phone}
              onClose={() => setSeriesOpen(null)}
              onDone={(data) => {
                setSeriesOpen(null);
                const lines = [
                  ...refundLines(t, data.refunds as Parameters<typeof refundLines>[1]),
                  ...(data.left ?? []).map((w) => t("series.leftOne", { date: w.date })),
                ];
                setNotice(lines.length > 0 ? lines.join(" ") : null);
                load();
              }}
            />
          </div>
        )}
        {upcoming.length === 0 ? (
          <div className="mt-3 rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">
            {t("acct.noneUpcoming")}{" "}
            <Link href="/" className="font-medium text-teal-700 underline">
              {t("acct.bookOne")}
            </Link>
          </div>
        ) : (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {upcoming.map((b) => (
              <BookingCard
                key={b.id}
                t={t}
                booking={b}
                onCancel={() => cancel(b)}
                onCancelSeries={
                  b.seriesCode ? () => cancelSeries(b.seriesCode!) : undefined
                }
                onChanged={(message) => {
                  setNotice(message);
                  load();
                }}
              />
            ))}
          </div>
        )}
      </section>

      {past.length > 0 && (
        <section>
          <h2 className="text-lg font-bold">{t("acct.pastTitle")}</h2>
          <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  {(
                    [
                      "acct.colCode",
                      "acct.colCourt",
                      "acct.colDate",
                      "acct.colTime",
                      "acct.colTotal",
                      "acct.colStatus",
                    ] as const
                  ).map((h) => (
                    <th key={h} className="px-3 py-2 font-semibold">
                      {t(h)}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {past.map((b) => (
                  <tr key={b.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 font-mono text-teal-700">{b.code}</td>
                    <td className="px-3 py-2">
                      {activityIcon(b.sport)} {b.courtName}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{b.date}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {formatHour(b.startHour, t.locale)} – {formatHour(b.endHour, t.locale)}
                    </td>
                    <td className="px-3 py-2">{b.totalPrice === 0 ? t("price.free") : `${money(b.totalPrice)}`}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                          b.status === "confirmed"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {b.status === "confirmed"
                          ? t("acct.played")
                          : t("acct.cancelledLower")}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className="inline-flex items-center gap-3">
                        {b.reviewUrl && (
                          <a href={b.reviewUrl} className="whitespace-nowrap text-sm font-semibold text-teal-700 underline">
                            ★ {t("review.rate")}
                          </a>
                        )}
                        {b.classId === null && <BookAgain code={b.code} />}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <VenueNews t={t} />

      <YourData t={t} />
    </div>
  );
}

/** Venues this account asked for news from, each with a way to stop (lib/marketing.ts). */
function VenueNews({ t }: { t: T }) {
  const [consents, setConsents] = useState<{ id: number; venueName: string; email: string; consentedAt: string; withdrawnAt: string | null }[] | null>(null);
  useEffect(() => {
    fetch("/api/my/marketing", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setConsents(d.consents ?? []))
      .catch(() => setConsents([]));
  }, []);
  if (consents === null) return null;
  return (
    <section>
      <h2 className="text-lg font-bold">{t("mkt.acctTitle")}</h2>
      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-5 text-sm shadow-sm">
        {consents.length === 0 ? (
          <p className="text-slate-600">{t("mkt.acctNone")}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {consents.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{c.venueName}</span>{" "}
                  <span className="text-slate-500">
                    · {c.email} · {c.withdrawnAt ? t("mkt.acctStopped") : t("mkt.acctSince", { date: c.consentedAt.slice(0, 10) })}
                  </span>
                </span>
                {!c.withdrawnAt && (
                  <button
                    type="button"
                    className="font-medium text-teal-700 underline"
                    onClick={async () => {
                      const res = await fetch("/api/my/marketing", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: c.id }),
                      });
                      if (res.ok) setConsents((await res.json()).consents);
                    }}
                  >
                    {t("mkt.acctStop")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * The two things a person is entitled to do with their own data: take a copy,
 * and be forgotten.
 */
function YourData({ t }: { t: T }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");

  async function close() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/my/erase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: typed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("data.closeFailed"));
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : t("data.closeFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="text-lg font-bold">{t("data.title")}</h2>
      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm text-slate-600">
          {t("data.intro1")}{" "}
          <a href="/privacy" className="font-medium text-teal-700 underline">
            {t("data.privacyLink")}
          </a>
          .
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <a
            href="/api/my/data"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-teal-600 hover:text-teal-700"
          >
            {t("data.download")}
          </a>
          {!confirming && (
            <button
              onClick={() => setConfirming(true)}
              className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
            >
              {t("data.close")}
            </button>
          )}
        </div>

        {confirming && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-semibold text-red-800">{t("data.irreversible")}</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm text-red-700">
              <li>
                {t("data.point1")} {t("d8b.data.money")}
              </li>
              <li>{t("data.point2")}</li>
              <li>{t("data.point3")}</li>
              <li>{t("data.point4")}</li>
            </ul>
            <p className="mt-2 text-sm text-red-700">
              {t("data.owedFirst")}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={t("data.typeDelete")}
                className="w-40 rounded-md border border-red-300 px-3 py-1.5 text-sm focus:border-red-500 focus:outline-none"
              />
              <button
                onClick={close}
                disabled={busy || typed !== "DELETE"}
                className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40"
              >
                {busy ? t("data.closing") : t("data.close")}
              </button>
              <button
                onClick={() => {
                  setConfirming(false);
                  setTyped("");
                }}
                className="px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-800"
              >
                {t("data.keep")}
              </button>
            </div>
            {error && <p className="mt-2 text-sm font-medium text-red-800">{error}</p>}
          </div>
        )}
      </div>
    </section>
  );
}

function BookingCard({
  t,
  booking: b,
  onCancel,
  onCancelSeries,
  onChanged,
}: {
  t: T;
  booking: UserBookingRow;
  onCancel: () => void;
  onCancelSeries?: () => void;
  /** Somebody was taken off it (lib/place-withdrawals.ts): what happened, to show, and the list read again. */
  onChanged?: (message: string) => void;
}) {
  const shareInfo = {
    code: b.code,
    date: b.date,
    startHour: b.startHour,
    endHour: b.endHour,
    courtName: b.courtName,
    venueName: b.venueName,
    venueAddress: b.venueAddress,
    timeZone: b.venueTimeZone,
    totalPrice: b.totalPrice,
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="font-mono text-lg font-bold text-teal-700">{b.code}</div>
        <div className="flex items-center gap-1.5">
          {b.seriesCode && (
            <span
              className="rounded-full bg-violet-50 px-2.5 py-1 font-mono text-xs font-semibold text-violet-700"
              title={t("acct.seriesTitle")}
            >
              🔁 {b.seriesCode}
            </span>
          )}
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
            {t("mine.confirmed")}
          </span>
        </div>
      </div>
      <div className="mt-3 space-y-1 text-sm">
        <div className="font-semibold">
          {activityIcon(b.sport)} {b.courtName}
        </div>
        {/* Who takes part, where that is somebody the account books for (a child; ADR 0023). */}
        {b.participantName && <div className="font-medium text-slate-700">{t("guard.forLine", { name: b.participantName })}</div>}
        <div className="text-slate-600">
          {b.venueName} ({b.venueArea})
        </div>
        <div className="text-slate-600">
          📅 {b.date} · {formatHour(b.startHour, t.locale)} – {formatHour(b.endHour, t.locale)}
        </div>
        <div className="font-medium">
          {b.totalPrice === 0 ? t("price.free") : `${money(b.totalPrice)}`}{" "}
          {b.totalPrice === 0 ? null : b.paymentStatus === "paid" ? (
            <span className="text-emerald-700">{t("acct.paid")}</span>
          ) : (
            <span className="text-slate-500">{t("acct.payAtCounter")}</span>
          )}
        </div>
      </div>
      {b.checkedInAt ? (
        <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-center text-xs font-medium text-emerald-700">
          {t("mine.checkedIn")}
        </p>
      ) : (
        b.checkInToken && <CheckInQr token={b.checkInToken} />
      )}
      <div className="mt-4 grid grid-cols-3 gap-2 text-xs font-medium">
        <a
          href={whatsappShareUrl(shareInfo)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-slate-300 py-1.5 text-center text-slate-700 hover:border-teal-500 hover:text-teal-700"
        >
          💬 {t("acct.share")}
        </a>
        <a
          href={googleCalendarUrl(shareInfo)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-slate-300 py-1.5 text-center text-slate-700 hover:border-teal-500 hover:text-teal-700"
        >
          📅 {t("acct.calendar")}
        </a>
        <button
          type="button"
          onClick={() => downloadIcs(shareInfo)}
          className="rounded-lg border border-slate-300 py-1.5 text-center text-slate-700 hover:border-teal-500 hover:text-teal-700"
        >
          ⬇️ .ics
        </button>
      </div>
      {/* Several people on it: one can be taken off, the others staying booked. */}
      {onChanged && b.classId === null && (b.participantName || (b.players ?? 1) > 1) && (
        <WithdrawPeople source={{ bookingId: b.id }} onDone={(_booking, message) => onChanged(message)} />
      )}
      <div className={`mt-2 grid gap-2 ${onCancelSeries ? "grid-cols-2" : ""}`}>
        <button
          onClick={onCancel}
          className="w-full rounded-lg border border-red-300 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
        >
          {t("mine.cancelBooking")}
        </button>
        {onCancelSeries && (
          <button
            onClick={onCancelSeries}
            className="w-full rounded-lg border border-red-300 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
          >
            {t("acct.cancelWholeSeries")}
          </button>
        )}
      </div>
    </div>
  );
}
