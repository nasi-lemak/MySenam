import { serverT } from "@/lib/locale";
import { consentByToken } from "@/lib/marketing";
import { UnsubscribeButton } from "@/components/UnsubscribeButton";

export const dynamic = "force-dynamic";

/**
 * The link at the foot of a venue's email. A button rather than stopping on
 * opening, so a mail scanner following links does not unsubscribe anybody.
 */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const t = await serverT();
  const { token } = await params;
  const consent = await consentByToken(token);
  return (
    <div className="mx-auto max-w-lg space-y-3 rounded-2xl border border-slate-200 bg-white p-6 text-sm shadow-sm">
      <h1 className="text-xl font-bold">{t(consent && !consent.withdrawn && !consent.confirmed ? "mkt.confirmTitle" : "mkt.unsubTitle")}</h1>
      {!consent ? (
        <p>{t("mkt.unsubBad")}</p>
      ) : consent.withdrawn ? (
        <p>{t("mkt.unsubDone", { venue: consent.venueName })}</p>
      ) : !consent.confirmed ? (
        <UnsubscribeButton token={token} venueName={consent.venueName} email={consent.email} confirm />
      ) : (
        <UnsubscribeButton token={token} venueName={consent.venueName} email={consent.email} />
      )}
    </div>
  );
}
