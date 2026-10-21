"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { formatHour, todayISO } from "@/lib/time";
import { SPORT_ICONS } from "@/lib/types";
import type { User } from "@/lib/auth";
import type { PhoneStatus } from "@/lib/phone-check";
import type { UserBookingRow } from "@/lib/store";
import { downloadIcs, googleCalendarUrl, whatsappShareUrl } from "@/lib/booking-links";
import CheckInQr from "@/components/CheckInQr";
import Wallet from "@/components/Wallet";
import MyWaitlist from "@/components/MyWaitlist";
import MyPasses from "@/components/MyPasses";
import MyReceipts from "@/components/MyReceipts";
import { ChangePassword } from "@/components/ChangePassword";
import { BookAgain } from "@/components/BookAgain";
import { MyVenues } from "@/components/MyVenues";
import { GuestInvites } from "@/components/GuestInvites";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import type { T } from "@/lib/i18n";
import { money } from "@/lib/region";

export default function AccountPage() {
  const router = useRouter();
  const t = useT();
  const [user, setUser] = useState<User | null>(null);
  const [phone, setPhone] = useState<PhoneStatus | null>(null);
  const [gender, setGender] = useState<string | null>(null);
  const [bookings, setBookings] = useState<UserBookingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

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

  async function cancelSeries(seriesCode: string, phone: string) {
    if (!window.confirm(t("acct.cancelSeriesConfirm", { code: seriesCode }))) return;
    setError(null);
    try {
      const res = await fetch("/api/bookings/cancel-series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seriesCode, phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("mine.cancelFailed"));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mine.cancelFailed"));
    }
  }

  async function cancel(bookingId: number) {
    if (!window.confirm(t("mine.cancelConfirm"))) return;
    setError(null);
    try {
      const res = await fetch("/api/my/bookings/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("mine.cancelFailed"));
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
      <GuestInvites />

      {regulars.length > 0 && (
        <section>
          <h2 className="text-lg font-bold">{t("again.title")}</h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-3">
            {regulars.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                <div className="min-w-0 text-sm">
                  <p className="truncate font-semibold">
                    {SPORT_ICONS[b.sport]} {b.venueName}
                  </p>
                  <p className="truncate text-slate-600">
                    {b.courtName} · {formatHour(b.startHour)}–{formatHour(b.endHour)}
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

      <Wallet />

      <MyPasses />

      <MyReceipts />

      <MyWaitlist phone={user.phone} />

      <section>
        <h2 className="text-lg font-bold">{t("acct.upcoming")}</h2>
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
                onCancel={() => cancel(b.id)}
                onCancelSeries={
                  b.seriesCode ? () => cancelSeries(b.seriesCode!, user.phone) : undefined
                }
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
                      {SPORT_ICONS[b.sport]} {b.courtName}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{b.date}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {formatHour(b.startHour)} – {formatHour(b.endHour)}
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
                    <td className="px-3 py-2 text-right">{b.classId === null && <BookAgain code={b.code} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <YourData t={t} />
    </div>
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
              <li>{t("data.point1")}</li>
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
}: {
  t: T;
  booking: UserBookingRow;
  onCancel: () => void;
  onCancelSeries?: () => void;
}) {
  const shareInfo = {
    code: b.code,
    date: b.date,
    startHour: b.startHour,
    endHour: b.endHour,
    courtName: b.courtName,
    venueName: b.venueName,
    venueAddress: b.venueAddress,
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
          {SPORT_ICONS[b.sport]} {b.courtName}
        </div>
        <div className="text-slate-600">
          {b.venueName} ({b.venueArea})
        </div>
        <div className="text-slate-600">
          📅 {b.date} · {formatHour(b.startHour)} – {formatHour(b.endHour)}
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
