import { notFound } from "next/navigation";
import { serverT } from "@/lib/locale";
import { money } from "@/lib/region";
import { siteName } from "@/lib/site";
import { todayISO } from "@/lib/time";
import { voucherForPage } from "@/lib/vouchers";
import { PrintButton } from "@/components/PrintButton";

export const dynamic = "force-dynamic";

/**
 * A gift voucher, to print or send on. Reached by a signed link (the email to
 * whoever bought it, the staff screen); the code alone finds nothing, so a
 * guessed address shows nobody's voucher.
 */
export default async function GiftVoucherPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await serverT();
  const { code } = await params;
  const token = (await searchParams).t;
  const voucher = typeof token === "string" ? await voucherForPage(decodeURIComponent(code), token) : null;
  if (!voucher) notFound();

  const unusable =
    voucher.status === "redeemed"
      ? t("gift.used")
      : voucher.status === "void"
        ? t("gift.cancelled")
        : voucher.expiresOn < todayISO()
          ? t("gift.expired")
          : null;
  return (
    <article className="mx-auto max-w-lg space-y-5 rounded-2xl border-2 border-dashed border-teal-300 bg-white p-8 text-center shadow-sm print:shadow-none">
      <div className="flex justify-end print:hidden">
        <PrintButton label={t("gift.print")} />
      </div>
      <p className="text-4xl" aria-hidden="true">
        🎁
      </p>
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-teal-700">{t("gift.card")}</p>
        <h1 className="mt-1 text-2xl font-bold">{voucher.venueName}</h1>
      </div>
      <p className="text-5xl font-bold text-teal-700">{money(voucher.amount)}</p>
      {voucher.recipientName && <p className="text-lg font-medium">{t("gift.for", { name: voucher.recipientName })}</p>}
      {voucher.message && <p className="whitespace-pre-line italic text-slate-600">“{voucher.message}”</p>}
      <p className="text-sm text-slate-500">{t("gift.from", { name: voucher.buyerName })}</p>
      <div className="rounded-xl bg-slate-50 px-4 py-3">
        <p className="text-xs uppercase tracking-wide text-slate-500">{t("gift.code")}</p>
        <p className="font-mono text-2xl font-bold tracking-wider">{voucher.code}</p>
        <p className="mt-1 text-xs text-slate-500">{t("gift.until", { date: voucher.expiresOn })}</p>
      </div>
      {unusable ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">{unusable}</p>
      ) : (
        <p className="text-sm text-slate-600">
          {t("gift.how", { site: siteName(), amount: money(voucher.amount), venue: voucher.venueName })}
        </p>
      )}
    </article>
  );
}
