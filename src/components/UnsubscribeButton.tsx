"use client";

import { useState } from "react";
import { useT } from "@/components/Language";

/** Stop a venue's news; or, with `confirm`, say yes to it from the email that asked, with a way to say no. */
export function UnsubscribeButton({
  token,
  venueName,
  email,
  confirm = false,
}: {
  token: string;
  venueName: string;
  email: string;
  confirm?: boolean;
}) {
  const t = useT();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  async function send(yes: boolean) {
    setBusy(true);
    const res = await fetch("/api/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(yes ? { token, confirm: true } : { token }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) setFailed(true);
    else if (yes) setConfirmed(true);
    else setDone(true);
  }
  if (done) return <p>{t("mkt.unsubDone", { venue: venueName })}</p>;
  if (confirmed) return <p>{t("mkt.confirmDone", { venue: venueName })}</p>;
  if (confirm)
    return (
      <>
        <p>{t("mkt.confirmAsk", { venue: venueName, email })}</p>
        {failed && <p className="text-rose-700">{t("mkt.unsubBad")}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void send(true)}
            className="rounded-md bg-teal-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
          >
            {t("mkt.confirmButton")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void send(false)}
            className="rounded-md border border-slate-300 px-4 py-2 font-semibold text-slate-700 disabled:opacity-50"
          >
            {t("mkt.confirmNo")}
          </button>
        </div>
      </>
    );
  return (
    <>
      <p>{t("mkt.unsubAsk", { venue: venueName, email })}</p>
      {failed && <p className="text-rose-700">{t("mkt.unsubBad")}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const res = await fetch("/api/unsubscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
          }).catch(() => null);
          setBusy(false);
          if (res?.ok) setDone(true);
          else setFailed(true);
        }}
        className="rounded-md bg-teal-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
      >
        {t("mkt.unsubButton")}
      </button>
    </>
  );
}
