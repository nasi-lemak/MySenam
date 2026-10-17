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
 * Where the link in a sign-up's confirmation email leads. Opening it confirms
 * the email and opens the account: a mail filter that follows links first
 * does that too, which still shows the inbox is real — all this check was
 * ever meant to show — and signs nobody in.
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
      <div className="mt-4 flex justify-center gap-4">
        <Link
          href="/admin"
          className="inline-block rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          {t("apply.signIn")}
        </Link>
        {!ok && (
          <Link href="/list-your-venue" className="inline-block py-2 text-sm font-semibold text-teal-700 underline">
            {t("confirm.again")}
          </Link>
        )}
      </div>
    </div>
  );
}
