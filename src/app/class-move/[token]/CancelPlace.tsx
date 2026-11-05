"use client";

import { useState } from "react";
import { useT } from "@/components/Language";
import { readJson } from "@/lib/read-response";
import { translateError } from "@/lib/i18n";

/**
 * One moved place's button: cancel it for everything back, once the customer has confirmed. The window and the money are
 * the server's (lib/class-moves.ts `cancelMovedPlace`); this only asks and says what came back.
 */
export default function CancelPlace({
  token,
  bookingId,
  state,
  until,
}: {
  token: string;
  bookingId: number;
  state: "open" | "cancelled" | "closed";
  until: string;
}) {
  const t = useT();
  const [now, setNow] = useState(state);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (now === "cancelled")
    return <p className="mt-3 font-semibold text-emerald-700">✓ {done ? t("clsa.page.done") : t("clsa.page.cancelled")}</p>;
  if (now === "closed") return <p className="mt-3 text-slate-600">{t("clsa.page.closed")}</p>;
  return (
    <div className="mt-3 space-y-2">
      <p className="text-slate-600">{t("clsa.page.until", { until })}</p>
      {error && <p className="font-medium text-red-700">{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm(t("clsa.page.confirm"))) return;
          setBusy(true);
          setError(null);
          const res = await fetch("/api/class-moves/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, bookingId }),
          }).catch(() => null);
          setBusy(false);
          if (!res) return setError(t("clsa.page.failed"));
          const data = await readJson(res);
          if (res.ok) {
            setDone(true);
            return setNow("cancelled");
          }
          setError(translateError(t, data) || t("clsa.page.failed"));
        }}
        className="w-full rounded-lg border border-red-300 py-2 font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
      >
        {busy ? t("clsa.page.working") : t("clsa.page.cancel")}
      </button>
    </div>
  );
}
