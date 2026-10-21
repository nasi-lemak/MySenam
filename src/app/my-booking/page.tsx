"use client";

import { useCallback, useState } from "react";
import { Booking, Court } from "@/lib/types";
import { formatHour, hoursUntilSlot } from "@/lib/time";
import { downloadIcs, googleCalendarUrl, whatsappShareUrl } from "@/lib/booking-links";
import CheckInQr from "@/components/CheckInQr";
import { ChangeTime } from "@/components/ChangeTime";
import { BookAgain } from "@/components/BookAgain";
import PayOnline from "@/components/PayOnline";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { refundLines } from "@/lib/refund-text";
import { money, intlTag, region } from "@/lib/region";

interface Result {
  booking: Booking;
  court: Court;
  venue: { name: string; area: string; address: string; cancelCutoffHours: number; timeZone?: string; lateCancelKeep?: number | null };
  payOnline?: boolean;
  addons?: { name: string; quantity: number; unitPrice: number }[];
  /** Once paid: its receipt, or tax invoice. */
  receiptUrl?: string | null;
}

export default function MyBookingPage() {
  const t = useT();
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What the venue kept of a late cancellation just made. */
  const [kept, setKept] = useState<number | null>(null);
  /** How money paid online for it is going back. */
  const [refunded, setRefunded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // The door code for an unmanned court, once asked for.
  const [door, setDoor] = useState<{
    accessCode: string;
    until: string;
    emergencyPhone: string | null;
    emergencyInfo: string | null;
    presentNow: number;
  } | null>(null);
  const [doorError, setDoorError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState<string | null>(null);
  const optionsUrl = useCallback(
    (date: string) =>
      `/api/bookings/reschedule?code=${encodeURIComponent(code)}&phone=${encodeURIComponent(phone)}&date=${date}`,
    [code, phone]
  );

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    setKept(null);
    setRefunded([]);
    try {
      const res = await fetch(
        `/api/bookings?code=${encodeURIComponent(code)}&phone=${encodeURIComponent(phone)}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("mine.lookupFailed"));
      setResult(data);
      setDoor(null);
      setDoorError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mine.lookupFailed"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Ask to be let in. This is a POST because it is not a read: the venue
   * writes down that the code was given out, and it counts as arriving.
   */
  async function getDoorCode() {
    setDoorError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("door.failed"));
      setDoor({
        accessCode: data.accessCode,
        until: data.until,
        emergencyPhone: data.emergencyPhone,
        emergencyInfo: data.emergencyInfo,
        presentNow: data.presentNow,
      });
    } catch (err) {
      setDoorError(err instanceof Error ? err.message : t("door.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!result) return;
    const { booking: bk, venue } = result;
    const keep = venue.lateCancelKeep ?? null;
    const late =
      keep !== null && hoursUntilSlot(bk.date, bk.startHour, venue.timeZone ?? region().timeZone) < venue.cancelCutoffHours;
    const askLate = late && keep > 0 && bk.paymentStatus === "paid" && bk.totalPrice > 0;
    if (!window.confirm(askLate ? t("mine.lateCancelConfirm", { pct: keep }) : t("mine.cancelConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("mine.cancelFailed"));
      setResult({ ...result, booking: data.booking });
      setKept(data.kept ?? null);
      setRefunded(refundLines(t, data.refunds));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mine.cancelFailed"));
    } finally {
      setBusy(false);
    }
  }

  const b = result?.booking;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("mine.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {t("mine.intro")}
        </p>
      </div>

      <form
        onSubmit={lookup}
        className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      >
        <label className="block text-sm font-medium text-slate-700">
          {t("mine.code")}
          <input
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="MS-XXXXXX"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono tracking-wider focus:border-teal-500 focus:outline-none"
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          {t("mine.phone")}
          <input
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t("auth.phonePlaceholder")}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {busy ? t("auth.working") : t("mine.find")}
        </button>
      </form>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {result && b && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="font-mono text-lg font-bold text-teal-700">{b.code}</div>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                b.status === "confirmed"
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-slate-100 text-slate-500"
              }`}
            >
              {b.status === "confirmed"
                ? b.holdUntil && b.paymentStatus === "unpaid"
                  ? t("hold.pill")
                  : t("mine.confirmed")
                : t("mine.cancelled")}
            </span>
          </div>
          {b.status === "cancelled" && kept !== null && kept > 0 && (
            <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {t("mine.lateCancelDone", { kept: money(kept) })}
            </p>
          )}
          {b.status === "cancelled" &&
            refunded.map((line) => (
              <p key={line} className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                {line}
              </p>
            ))}
          {b.releasedUnpaid && (
            <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{t("hold.released")}</p>
          )}
          {b.status === "confirmed" && b.paymentStatus === "unpaid" && b.holdUntil && (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
              {t("hold.pending", {
                time: new Date(`${b.holdUntil.replace(" ", "T")}Z`).toLocaleTimeString(intlTag("en"), {
                  timeZone: result.venue.timeZone ?? region().timeZone,
                  hour: "numeric",
                  minute: "2-digit",
                }),
              })}
            </p>
          )}
          <dl className="mt-4 space-y-1.5 text-sm">
            {[
              [t("mine.venue"), `${result.venue.name} (${result.venue.area})`],
              [t("mine.address"), result.venue.address],
              [t("mine.court"), result.court.name],
              [t("mine.date"), b.date],
              [t("mine.time"), `${formatHour(b.startHour)} – ${formatHour(b.endHour)}`],
              [t("mine.bookedBy"), b.name],
              ...(result.addons?.length
                ? [[t("done.extras"), result.addons.map((a) => `${a.quantity} × ${a.name} (${money(a.unitPrice)})`).join(", ")]]
                : []),
              [
                t("mine.total"),
                b.totalPrice === 0
                  ? t("price.free")
                  : b.holdUntil && b.paymentStatus === "unpaid"
                    ? t("hold.total", { amount: b.totalPrice })
                    : b.paymentStatus === "paid"
                  ? b.paidOnline
                    ? `${t("mine.paid", { amount: b.totalPrice })} · ${t("pay.paidOnline")}`
                    : t("mine.paid", { amount: b.totalPrice })
                  : t("mine.unpaid", { amount: b.totalPrice }),
              ],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4">
                <dt className="shrink-0 text-slate-500">{label}</dt>
                <dd className="text-right font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {result.receiptUrl && (
            <a href={result.receiptUrl} target="_blank" rel="noopener" className="mt-3 inline-block text-sm font-semibold text-teal-700 underline">
              {t("mine.receipt")}
            </a>
          )}
          {b.classId === null && (
            <div className="mt-3">
              <BookAgain code={b.code} phone={phone} />
            </div>
          )}
          {b.status === "confirmed" && (
            <>
              {result.payOnline && b.paymentStatus === "unpaid" && b.totalPrice > 0 && (
                <PayOnline codes={[b.code]} phone={phone} amount={b.totalPrice} held={!!b.holdUntil} />
              )}
              {result.venue.cancelCutoffHours > 0 && (
                <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  {t.plural("mine.freeCancel", result.venue.cancelCutoffHours)}
                  {result.venue.lateCancelKeep != null && result.venue.lateCancelKeep > 0 && (
                    <> {t("mine.lateCancelNote", { pct: result.venue.lateCancelKeep })}</>
                  )}
                </p>
              )}
              {result.court.unmanned ? (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-4">
                  <p className="text-sm font-semibold text-amber-900">
                    {t("door.nobodyOn", { court: result.court.name })}
                  </p>
                  <p className="mt-0.5 text-xs text-amber-800">
                    {t("door.hint")}
                  </p>
                  {door ? (
                    <div className="mt-3 rounded-lg bg-white px-4 py-3 text-center">
                      <div className="font-mono text-3xl font-bold tracking-[0.3em] text-teal-700">
                        {door.accessCode}
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {t("door.yoursUntil", { time: door.until })}
                      </p>
                    </div>
                  ) : null}
                  {door && (
                    <div className="mt-3 rounded-lg border border-amber-300 bg-white px-3 py-2.5">
                      <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                        {t("door.emergencyTitle")}
                      </p>
                      <p className="mt-1 text-xs text-slate-700">
                        {t("door.emergencyServices")} <strong>999</strong>
                        {door.emergencyPhone && (
                          <>
                            {" · "}
                            {t("door.venuePhone")}{" "}
                            <a href={`tel:${door.emergencyPhone}`} className="font-semibold underline">
                              {door.emergencyPhone}
                            </a>
                          </>
                        )}
                      </p>
                      {door.emergencyInfo && (
                        <p className="mt-1 text-xs text-slate-600">{door.emergencyInfo}</p>
                      )}
                      <p className="mt-1.5 text-xs text-slate-500">
                        {door.presentNow <= 1
                          ? t("door.alone")
                          : t("door.withOthers", { n: door.presentNow })}
                      </p>
                    </div>
                  )}
                  {!door && (
                    <button
                      onClick={getDoorCode}
                      disabled={busy}
                      className="mt-3 w-full rounded-lg bg-amber-600 py-2.5 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                    >
                      {busy ? t("auth.working") : t("door.show")}
                    </button>
                  )}
                  {doorError && (
                    <p className="mt-2 text-xs font-medium text-red-700">{doorError}</p>
                  )}
                </div>
              ) : b.checkedInAt ? (
                <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-center text-xs font-medium text-emerald-700">
                  {t("mine.checkedIn")}
                </p>
              ) : (
                b.checkInToken && <CheckInQr token={b.checkInToken} />
              )}
              <div className="mt-5 grid grid-cols-3 gap-2 text-xs font-medium">
                {(() => {
                  const shareInfo = {
                    siteName: t.site,
                    code: b.code,
                    date: b.date,
                    startHour: b.startHour,
                    endHour: b.endHour,
                    courtName: result.court.name,
                    venueName: result.venue.name,
                    venueAddress: result.venue.address,
                    timeZone: result.venue.timeZone,
                    totalPrice: b.totalPrice,
                  };
                  return (
                    <>
                      <a
                        href={whatsappShareUrl(shareInfo)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-lg border border-slate-300 py-2 text-center text-slate-700 hover:border-teal-500 hover:text-teal-700"
                      >
                        💬 WhatsApp
                      </a>
                      <a
                        href={googleCalendarUrl(shareInfo)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-lg border border-slate-300 py-2 text-center text-slate-700 hover:border-teal-500 hover:text-teal-700"
                      >
                        📅 Google Cal
                      </a>
                      <button
                        type="button"
                        onClick={() => downloadIcs(shareInfo)}
                        className="rounded-lg border border-slate-300 py-2 text-center text-slate-700 hover:border-teal-500 hover:text-teal-700"
                      >
                        ⬇️ {t("done.icsFile")}
                      </button>
                    </>
                  );
                })()}
              </div>
              {changed && <p role="status" className="mt-3 text-sm font-medium text-teal-700">{changed}</p>}
              {b.classId === null &&
                (changing ? (
                  <div className="mt-3">
                    <ChangeTime
                      booking={b}
                      optionsUrl={optionsUrl}
                      submit={(o, date) =>
                        fetch("/api/bookings/reschedule", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ code, phone, date, startHour: o.startHour }),
                        })
                      }
                      onDone={async (_booking, message) => {
                        setChanging(false);
                        setChanged(message);
                        // Read it back whole: the court, the price and the check-in code go with it.
                        const res = await fetch(
                          `/api/bookings?code=${encodeURIComponent(code)}&phone=${encodeURIComponent(phone)}`,
                          { cache: "no-store" }
                        );
                        if (res.ok) setResult(await res.json());
                      }}
                      onClose={() => setChanging(false)}
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setChanging(true);
                      setChanged(null);
                    }}
                    disabled={busy}
                    className="mt-3 w-full rounded-lg border border-teal-300 py-2.5 font-semibold text-teal-700 hover:bg-teal-50 disabled:opacity-50"
                  >
                    {t("resched.button")}
                  </button>
                ))}
              <button
                onClick={cancel}
                disabled={busy}
                className="mt-3 w-full rounded-lg border border-red-300 py-2.5 font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                {t("mine.cancelBooking")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
