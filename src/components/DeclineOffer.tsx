"use client";

import { useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { readJson } from "@/lib/read-response";

/**
 * "No thanks, offer it to the next person" on a waiting-list offer (audit R8
 * X2-9): the entry leaves the list and the place goes at once to whoever waits
 * next (POST /api/waitlist/leave with the offer's token), rather than being
 * held for nobody until the offer runs out. Asked once more before it is done.
 */
export default function DeclineOffer({ token, disabled = false, onDeclined }: { token: string; disabled?: boolean; onDeclined: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decline() {
    if (!window.confirm(t("q8b.wl.declineConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/waitlist/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerToken: token }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(translateError(t, data) || t("q8b.wl.leaveFailed"));
      onDeclined();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("q8b.wl.leaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={decline}
        disabled={busy || disabled}
        className="mt-2 w-full rounded-lg border border-slate-300 py-2.5 text-sm font-medium text-slate-600 hover:border-slate-400 disabled:opacity-50"
      >
        {busy ? t("q8b.wl.leaving") : t("q8b.wl.decline")}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </>
  );
}
