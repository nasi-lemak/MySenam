"use client";

import { readJson } from "@/lib/read-response";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { Booking, ClassSession } from "@/lib/types";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import WaiverTick from "@/components/WaiverTick";
import PayOnline from "@/components/PayOnline";
import { HoldNotice } from "@/components/BookingPayment";
import { localTimeOf, minuteClock, money, shortDate } from "@/lib/region";
import type { OfferView } from "@/lib/waitlist-offer";
import DeclineOffer from "@/components/DeclineOffer";

interface Claimed {
  booking: Booking;
  bookings: Booking[];
  session: ClassSession | null;
  holdUntil: string | null;
  court?: { id: number; name: string };
  venue?: { id: number; name: string; area: string; timeZone: string };
  payOnline?: boolean;
  depositPercent?: number | null;
  /** The booking's signed link (lib/booking-access.ts): pays for it, and opens it on My Booking. */
  link?: string;
}

/**
 * A waiting-list offer, from the link in its message: what is offered first
 * (the venue, the court or class, when, for whom, the price, until when it
 * stands, and whether it must then be paid online to keep), then, claimed,
 * the booking as the booking form's confirmation shows one: held until paid
 * online with the way to pay, or booked (lib/waitlist-offer.ts).
 */
export default function ClaimPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const [offer, setOffer] = useState<OfferView | null>(null);
  const [result, setResult] = useState<Claimed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The venue's waiver, asked here where the place is booked: its venue, once the claim says one is needed.
  const [waiverVenue, setWaiverVenue] = useState<{ id: number; name: string } | null>(null);
  const [agreeWaiver, setAgreeWaiver] = useState(false);
  // Turned down: the place has gone to the next person waiting (components/DeclineOffer.tsx).
  const [declined, setDeclined] = useState(false);

  // What is offered, read before anything is claimed: a gone offer says so at once.
  useEffect(() => {
    let live = true;
    setError(null);
    fetch(`/api/waitlist/claim?token=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await readJson(res).catch(() => null);
        if (!live) return;
        if (res.ok && data?.offer) setOffer(data.offer);
        else if (data?.code === "OFFER_EXPIRED" || data?.code === "OFFER_INVALID") setError(translateError(t, data));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [token, t]);

  const claim = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/waitlist/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...(agreeWaiver ? { agreeWaiver: true } : {}) }),
      });
      const data = await readJson(res);
      // Not agreed to yet: the offer still stands; tick the box and claim again.
      if (!res.ok && data?.code === "WAIVER_NEEDED" && Number.isInteger(data?.vars?.venueId)) {
        setWaiverVenue({ id: data.vars.venueId, name: typeof data.vars.venue === "string" ? data.vars.venue : "" });
        return;
      }
      if (!res.ok) throw new Error(translateError(t, data) || t("claim.failed"));
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("claim.failed"));
    } finally {
      setBusy(false);
    }
  }, [token, t, agreeWaiver]);

  const venueId = result?.venue?.id ?? offer?.venue.id ?? null;
  const unpaid = result ? result.bookings.filter((b) => b.paymentStatus === "unpaid" && b.totalPrice > 0) : [];
  const due = Math.round(unpaid.reduce((sum, b) => sum + b.totalPrice - (b.sharesPaid ?? 0), 0) * 100) / 100;

  return (
    <div className="mx-auto max-w-sm">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        {result ? (
          <>
            <div className="text-5xl">{result.holdUntil ? "⏳" : "🎉"}</div>
            <h1 className="mt-3 text-xl font-bold">{result.holdUntil ? t("hold.title") : t("claim.yoursTitle")}</h1>
            {result.session ? (
              <p className="mt-1 text-sm text-slate-600">
                {t("claim.with", { name: result.session.name, instructor: result.session.instructor })}
              </p>
            ) : (
              result.court && <p className="mt-1 text-sm text-slate-600">{result.court.name}</p>
            )}
            {result.venue && <p className="text-sm text-slate-600">{result.venue.name}</p>}
            <p className="text-sm text-slate-600" data-testid="claim-when">
              {shortDate(result.booking.date, t.locale, true)} · {minuteClock(result.booking.startMin ?? Math.round(result.booking.startHour * 60), t.locale)} –{" "}
              {minuteClock(result.booking.endMin ?? Math.round(result.booking.endHour * 60), t.locale)}
            </p>
            <div className="mt-4 rounded-xl bg-teal-50 py-3 text-2xl font-bold tracking-widest text-teal-700">{result.booking.code}</div>
            {/* Booked for whom the place was waited for: a child, never the adult in their place (ADR 0023). */}
            {result.booking.participantName && (
              <p className="mt-2 text-sm font-medium text-slate-700">{t("guard.forLine", { name: result.booking.participantName })}</p>
            )}
            {/* Held until paid online: until when, and the way to pay, never "at the counter" (components/BookingPayment.tsx). */}
            <HoldNotice booking={{ ...result.booking, holdUntil: result.holdUntil }} timeZone={result.venue?.timeZone} />
            {result.payOnline && due > 0 && result.link && (
              <PayOnline
                codes={unpaid.map((b) => b.code)}
                link={result.link}
                amount={due}
                held={result.holdUntil !== null}
                depositPercent={result.depositPercent ?? null}
              />
            )}
            {!result.holdUntil && (
              <p className="mt-2 text-xs text-slate-500">
                {result.booking.paymentStatus === "paid" || result.booking.totalPrice === 0
                  ? result.booking.totalPrice === 0
                    ? t("price.free")
                    : t("mine.paid", { amount: result.booking.totalPrice })
                  : t("claim.payable", { amount: result.booking.totalPrice })}
              </p>
            )}
            {result.link && (
              <Link
                href={`/my-booking?code=${encodeURIComponent(result.booking.code)}&t=${encodeURIComponent(result.link)}`}
                className="mt-4 inline-block text-sm font-medium text-teal-700 underline"
              >
                {t("pay.toMyBooking")}
              </Link>
            )}
          </>
        ) : declined ? (
          <>
            <div className="text-5xl" aria-hidden="true">👋</div>
            <h1 className="mt-3 text-xl font-bold">{t("q8b.wl.declinedTitle")}</h1>
            <p role="status" className="mt-2 text-sm text-slate-600">{t("q8b.wl.declinedBody")}</p>
          </>
        ) : error ? (
          <>
            <div className="text-5xl">⌛</div>
            <h1 className="mt-3 text-xl font-bold">{t("claim.goneTitle")}</h1>
            <p className="mt-2 text-sm text-red-600">{error}</p>
            <p className="mt-3 text-xs text-slate-500">{t("claim.goneBody")}</p>
          </>
        ) : (
          <>
            <div className="text-5xl">🎟️</div>
            <h1 className="mt-3 text-xl font-bold">{t("claim.openTitle")}</h1>
            <p className="mt-2 text-sm text-slate-600">{t("claim.openBody")}</p>
            {offer && (
              <dl className="mt-4 space-y-1.5 rounded-xl bg-slate-50 p-3 text-left text-sm" data-testid="offer-details">
                {(
                  [
                    [t("mine.venue"), `${offer.venue.name} (${offer.venue.area})`],
                    [offer.kind === "class" ? t("q8a.claim.class") : t("mine.court"), offer.instructor ? t("claim.with", { name: offer.what, instructor: offer.instructor }) : offer.what],
                    [t("mine.date"), shortDate(offer.date, t.locale, true)],
                    [t("mine.time"), `${minuteClock(offer.startMin, t.locale)} – ${minuteClock(offer.endMin, t.locale)}`],
                    ...(offer.forNames.length > 0 ? [[t("q8a.claim.for"), offer.forNames.join(", ")]] : []),
                    ...(offer.places > 1 ? [[t("done.players"), String(offer.places)]] : []),
                    ...(offer.price !== null ? [[t("mine.total"), offer.price === 0 ? t("price.free") : money(offer.price)]] : []),
                  ] as [string, string][]
                ).map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-4">
                    <dt className="shrink-0 text-slate-500">{label}</dt>
                    <dd className="text-right font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {offer && (
              <p className="mt-3 text-xs text-slate-600" data-testid="offer-ends">
                {t("q8a.claim.offerEnds", { time: localTimeOf(offer.offerEnds, offer.venue.timeZone, t.locale) })}
              </p>
            )}
            {/* Said before claiming: claimed, it is held until paid online and let go after (lib/waitlist-offer.ts). */}
            {offer?.holdMinutes != null && (
              <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-left text-sm font-medium text-amber-900" data-testid="offer-hold">
                {t("q8a.claim.holdBefore", { minutes: offer.holdMinutes })}
              </p>
            )}
            {waiverVenue !== null && (
              <div className="mt-3 text-left">
                <p className="text-xs text-amber-700">{t("err.WAIVER_NEEDED")}</p>
                <WaiverTick venueId={waiverVenue.id} venueName={waiverVenue.name} checked={agreeWaiver} onChange={setAgreeWaiver} />
              </div>
            )}
            <button
              onClick={claim}
              disabled={busy || (waiverVenue !== null && !agreeWaiver)}
              className="mt-5 w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {busy ? t("claim.working") : t("claim.button")}
            </button>
            <DeclineOffer token={token} disabled={busy} onDeclined={() => setDeclined(true)} />
          </>
        )}
        {/* Back to the venue the offer is at; the classes list where it is not known. */}
        <Link href={venueId ? `/venue/${venueId}` : "/classes"} className="mt-5 block text-sm font-medium text-teal-700 underline">
          {venueId ? t("q8a.claim.toVenue") : t("claim.back")}
        </Link>
      </div>
    </div>
  );
}
