"use client";

import PayOnline from "@/components/PayOnline";
import { SplitCost } from "@/components/SplitCost";
import { useT } from "@/components/Language";
import { localTimeOf } from "@/lib/region";
import type { Booking } from "@/lib/types";

/**
 * Whether a booking is held until it is paid online (lib/holds.ts): booked,
 * nothing paid, and a time it is let go at.
 */
export function isHeld(b: Pick<Booking, "status" | "paymentStatus" | "holdUntil">): boolean {
  return b.status === "confirmed" && b.paymentStatus === "unpaid" && !!b.holdUntil;
}

/**
 * "Held until 6:45 PM while you pay online": the hold's end, in the venue's
 * time and the reader's language. Shown wherever a held booking is (My
 * Booking, the account page, the payment return page, a waiting-list claim),
 * so no page calls it confirmed, or payable at the counter, while it runs.
 */
export function HoldNotice({ booking, timeZone }: { booking: Pick<Booking, "status" | "paymentStatus" | "holdUntil">; timeZone?: string }) {
  const t = useT();
  if (!isHeld(booking)) return null;
  return (
    <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900" data-testid="hold-notice">
      {t("hold.pending", { time: localTimeOf(booking.holdUntil!, timeZone, t.locale) })}
    </p>
  );
}

/**
 * Paying for a booking that is still to pay, as My Booking and the account
 * page both offer it: online where the venue takes payment online (all of it,
 * or the venue's deposit to hold it), and, for court time not held, splitting
 * the cost with the others playing. Proof is the booking's phone, or its
 * signed link where no phone is to hand (lib/booking-access.ts).
 */
export function BookingPayment({
  booking: b,
  phone,
  link,
  payOnline,
  depositPercent = null,
  venueName,
}: {
  booking: Booking;
  phone?: string;
  link?: string;
  payOnline: boolean;
  depositPercent?: number | null;
  venueName: string;
}) {
  if (!payOnline || b.status !== "confirmed" || b.paymentStatus !== "unpaid" || b.totalPrice <= 0) return null;
  const due = Math.round((b.totalPrice - (b.sharesPaid ?? 0)) * 100) / 100;
  return (
    <>
      <PayOnline codes={[b.code]} phone={phone} link={link} amount={due} held={!!b.holdUntil} depositPercent={depositPercent} />
      {/* Held: it is paid whole, now, or let go; splitting asks others to pay later. */}
      {!b.holdUntil && b.classId === null && phone && (
        <SplitCost code={b.code} phone={phone} total={due} venueName={venueName} date={b.date} />
      )}
    </>
  );
}
