import { notFound } from "next/navigation";
import { CoachDifference } from "@/components/CoachDifference";
import { changeOfPayToken, coachDifferences } from "@/lib/lesson-coaches";
import { serverT } from "@/lib/locale";
import { takesPaymentOnline } from "@/lib/payments";
import { receiptPath } from "@/lib/receipts";
import { money } from "@/lib/region";

export const dynamic = "force-dynamic";

/**
 * The link in the coach-change email: the difference a paid lesson owes for
 * a dearer coach, and paying it online for exactly that amount where the
 * venue takes payment online (lib/lesson-coaches.ts coachPayToken). The
 * counter stays an option; once paid, its receipt; no longer owed, it says so.
 */
export default async function CoachDifferencePage({ params }: { params: Promise<{ token: string }> }) {
  const t = await serverT();
  const { token } = await params;
  const changeId = changeOfPayToken(token);
  const view = changeId === null ? null : (await coachDifferences({ changeId }))[0];
  if (!view) notFound();
  const online = view.state === "owed" || view.state === "paying" ? await takesPaymentOnline(view.venueId) : false;
  return (
    <div className="mx-auto max-w-lg space-y-3 rounded-2xl border border-slate-200 bg-white p-6 text-sm shadow-sm">
      <h1 className="text-xl font-bold">{t("cp7.pageTitle", { venue: view.venueName })}</h1>
      <p className="text-slate-600">{t("cp7.pageWhat", { code: view.bookingCode, to: view.toCoach, from: view.fromCoach, amount: money(view.amount) })}</p>
      {view.state === "cleared" ? (
        <p className="rounded-md bg-slate-50 p-3 font-medium">{t("cp7.cleared")}</p>
      ) : (
        <CoachDifference
          items={[
            {
              changeId: view.changeId,
              amount: view.amount,
              coach: view.toCoach,
              state: view.state,
              via: view.via,
              receiptUrl: view.receipt ? receiptPath(view.receipt) : null,
            },
          ]}
          source={{ token }}
          payOnline={online}
        />
      )}
    </div>
  );
}
