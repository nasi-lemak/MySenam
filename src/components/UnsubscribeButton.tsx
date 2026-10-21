"use client";

import { useState } from "react";
import { useT } from "@/components/Language";

export function UnsubscribeButton({ token, venueName, email }: { token: string; venueName: string; email: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (done) return <p>{t("mkt.unsubDone", { venue: venueName })}</p>;
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
