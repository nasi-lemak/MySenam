import { noticeByToken } from "@/lib/urgent";
import { serverT } from "@/lib/locale";
import AckButton from "./AckButton";

export const dynamic = "force-dynamic";

/**
 * Where a "Seen it" link lands. Opening the page does not count — email
 * scanners open links on their own — so the customer taps once more.
 */
export default async function AckPage({ params }: { params: Promise<{ token: string }> }) {
  const t = await serverT();
  const { token } = await params;
  const notice = await noticeByToken(token);
  return (
    <div className="mx-auto max-w-md space-y-4 py-10 text-center">
      {!notice ? (
        <p className="text-slate-600">{t("ack.unknown")}</p>
      ) : (
        <>
          <h1 className="text-xl font-bold">{t("ack.title")}</h1>
          <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">{notice.summary}</p>
          <AckButton token={token} done={notice.ackedAt !== null} />
        </>
      )}
    </div>
  );
}
