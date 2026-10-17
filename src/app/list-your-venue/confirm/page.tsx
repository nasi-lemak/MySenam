import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { confirmApplicationEmail } from "@/lib/applications";
import { isMarketplace } from "@/lib/mode";
import { serverT } from "@/lib/locale";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return { title: t("confirm.title"), robots: { index: false } };
}

/**
 * Where the link in an applicant's confirmation email leads. Opening it
 * confirms: a mail filter that follows links first confirms it too, which
 * still shows the inbox is real — all this check was ever meant to show.
 */
export default async function ConfirmApplicationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  if (!isMarketplace()) notFound();
  const t = await serverT();
  const { token } = await searchParams;
  const result = await confirmApplicationEmail(typeof token === "string" ? token : "");
  const ok = result === "confirmed";
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
      <div className="text-4xl">{ok ? "✅" : "⌛"}</div>
      <h1 className="mt-2 text-xl font-bold">{t(ok ? "confirm.title" : "confirm.unknownTitle")}</h1>
      <p className="mt-2 text-sm text-slate-600">{t(ok ? "confirm.body" : "confirm.unknownBody")}</p>
      {!ok && (
        <Link href="/list-your-venue" className="mt-4 inline-block text-sm font-semibold text-teal-700 underline">
          {t("confirm.again")}
        </Link>
      )}
    </div>
  );
}
