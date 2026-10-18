"use client";

import { useState } from "react";
import { useT } from "@/components/Language";

export default function AckButton({ token, done }: { token: string; done: boolean }) {
  const t = useT();
  const [seen, setSeen] = useState(done);
  const [busy, setBusy] = useState(false);
  if (seen) return <p className="font-semibold text-emerald-700">✓ {t("ack.done")}</p>;
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const res = await fetch("/api/ack", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        }).catch(() => null);
        setBusy(false);
        if (res?.ok) setSeen(true);
      }}
      className="w-full rounded-lg bg-teal-600 py-3 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
    >
      {t("ack.button")}
    </button>
  );
}
