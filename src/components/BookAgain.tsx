"use client";

import { useState } from "react";
import { useT } from "@/components/Language";

/**
 * One tap from an old booking to the same court and hours on the next day
 * they are free, picked and waiting on the venue page. `phone` is for a
 * booking looked up by code; signed in, one's own bookings need none.
 */
export function BookAgain({ code, phone, className }: { code: string; phone?: string; className?: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function go() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(
        `/api/bookings/again?code=${encodeURIComponent(code)}${phone ? `&phone=${encodeURIComponent(phone)}` : ""}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok || typeof data.url !== "string") throw new Error();
      window.location.assign(data.url);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col">
      <button
        onClick={go}
        disabled={busy}
        className={
          className ??
          "inline-flex min-h-8 items-center rounded-lg border border-teal-300 px-3 text-xs font-semibold text-teal-700 hover:bg-teal-50 disabled:opacity-50"
        }
      >
        {busy ? t("again.working") : t("again.button")}
      </button>
      {failed && <span className="mt-1 text-xs text-red-600">{t("again.failed")}</span>}
    </span>
  );
}
