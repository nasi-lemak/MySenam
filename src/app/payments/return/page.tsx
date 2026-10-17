import Link from "next/link";
import { redirectBillId, verifyRedirect } from "@/lib/billplz";
import { accountForBill, paymentByBill, settleBill } from "@/lib/payments";
import { serverT } from "@/lib/locale";

export const dynamic = "force-dynamic";

/**
 * Where the gateway sends the customer back.
 *
 * The result in the address is signed, and is believed only when the
 * signature checks out under the venue's key — then it settles the booking
 * exactly as the server-to-server callback would, since either may arrive
 * first and the callback may be late. An address without a good signature
 * changes nothing, whatever it says.
 */
export default async function PaymentReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await serverT();
  const raw = await searchParams;
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") query.set(k, v);

  const billId = redirectBillId(query);
  const account = billId ? await accountForBill(billId) : null;
  const result = account ? verifyRedirect(query, account.xSignatureKey) : null;
  if (result) await settleBill(result);
  const payment = result ? await paymentByBill(result.billId) : null;

  // A venue paying its marketplace invoice, rather than a customer paying for
  // a booking: staff, in English like the rest of the admin, and back to it.
  if (payment?.purpose === "invoice")
    return (
      <div className="mx-auto max-w-sm">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="text-4xl">{payment.status === "paid" ? "✅" : "↩️"}</div>
          <h1 className="mt-2 text-xl font-bold">
            {payment.status === "paid" ? "Invoice paid" : "Invoice not paid"}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {payment.status === "paid"
              ? `Thank you. RM${payment.amount} has been received.`
              : "Nothing was taken. You can try again from Billing."}
          </p>
          <Link
            href="/admin"
            className="mt-5 inline-block w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
          >
            Back to admin
          </Link>
        </div>
      </div>
    );

  // A tournament entry fee.
  if (payment?.purpose === "entry" && payment.status === "paid")
    return (
      <div className="mx-auto max-w-sm">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="text-4xl">✅</div>
          <h1 className="mt-2 text-xl font-bold">{t("pay.entryTitle")}</h1>
          <p className="mt-2 text-sm text-slate-600">{t("pay.entryBody", { amount: payment.amount })}</p>
          <Link
            href="/tournaments"
            className="mt-5 inline-block w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
          >
            {t("pay.entryBack")}
          </Link>
        </div>
      </div>
    );

  // A season's league fee.
  if (payment?.purpose === "league" && payment.status === "paid")
    return (
      <div className="mx-auto max-w-sm">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="text-4xl">✅</div>
          <h1 className="mt-2 text-xl font-bold">{t("pay.leagueTitle")}</h1>
          <p className="mt-2 text-sm text-slate-600">{t("pay.leagueBody", { amount: payment.amount })}</p>
          <Link
            href="/leagues"
            className="mt-5 inline-block w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
          >
            {t("pay.leagueBack")}
          </Link>
        </div>
      </div>
    );

  // A player's share of somebody else's open game.
  if (payment?.purpose === "share" && payment.status === "paid")
    return (
      <div className="mx-auto max-w-sm">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="text-4xl">✅</div>
          <h1 className="mt-2 text-xl font-bold">{t("pay.shareTitle")}</h1>
          <p className="mt-2 text-sm text-slate-600">{t("pay.shareBody", { amount: payment.amount })}</p>
          <Link
            href="/games"
            className="mt-5 inline-block w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
          >
            {t("pay.shareBack")}
          </Link>
        </div>
      </div>
    );

  const outcome: "paid" | "notPaid" | "unknown" = !result
    ? "unknown"
    : payment?.status === "paid"
      ? "paid"
      : result.paid
        ? "unknown"
        : "notPaid";

  return (
    <div className="mx-auto max-w-sm">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="text-4xl">{outcome === "paid" ? "✅" : outcome === "notPaid" ? "↩️" : "⏳"}</div>
        <h1 className="mt-2 text-xl font-bold">
          {outcome === "paid"
            ? t("pay.receivedTitle")
            : outcome === "notPaid"
              ? t("pay.notPaidTitle")
              : t("pay.unknownTitle")}
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          {outcome === "paid" && payment
            ? t("pay.receivedBody", { amount: payment.amount, codes: payment.bookingCodes.join(", ") })
            : outcome === "notPaid"
              ? t("pay.notPaidBody")
              : t("pay.unknownBody")}
        </p>
        <Link
          href="/my-booking"
          className="mt-5 inline-block w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
        >
          {t("pay.toMyBooking")}
        </Link>
      </div>
    </div>
  );
}
