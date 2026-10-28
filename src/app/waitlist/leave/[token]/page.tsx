"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { readJson } from "@/lib/read-response";
import { clockRange, shortDate } from "@/lib/region";

interface Entry {
  what: string;
  venueName: string;
  date: string | null;
  startMin: number | null;
  endMin: number | null;
  waiting: boolean;
}

/**
 * Leaving a waiting list by the entry's private link (audit R8 X2-9): the
 * link on the joined screen and in the email saying so. Says what the entry
 * waits for, and takes it off the list only when asked: a link opened by a
 * mail scanner changes nothing.
 */
export default function LeaveWaitlistPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const [entry, setEntry] = useState<Entry | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "gone" | "left">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/waitlist/leave?token=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await readJson(res);
        if (!live) return;
        if (res.status === 404) return setState("gone");
        if (!res.ok) throw new Error(translateError(t, data));
        setEntry(data.entry);
        setState(data.entry.waiting ? "ready" : "gone");
      })
      .catch((err) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : t("q8b.wl.leaveFailed"));
        setState("ready");
      });
    return () => {
      live = false;
    };
  }, [token, t]);

  async function leave() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/waitlist/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await readJson(res);
      // Left already, taken up, or run its course: nothing left to leave.
      if (data?.code === "WAITLIST_NOT_FOUND" || data?.code === "PLACE_ALREADY_CLAIMED") return setState("gone");
      if (!res.ok) throw new Error(translateError(t, data) || t("q8b.wl.leaveFailed"));
      setState("left");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("q8b.wl.leaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const when =
    entry?.date && entry.startMin !== null && entry.endMin !== null
      ? `${shortDate(entry.date, t.locale, true)} · ${clockRange(entry.startMin, entry.endMin, t.locale)}`
      : entry?.date
        ? shortDate(entry.date, t.locale, true)
        : "";

  return (
    <div className="mx-auto max-w-sm">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        {state === "loading" ? (
          <p className="text-sm text-slate-500">{t("board.loading")}</p>
        ) : state === "left" ? (
          <>
            <div className="text-5xl" aria-hidden="true">👋</div>
            <h1 className="mt-3 text-xl font-bold">{t("q8b.wl.leftTitle")}</h1>
            <p role="status" className="mt-2 text-sm text-slate-600">{t("q8b.wl.leftBody")}</p>
          </>
        ) : state === "gone" ? (
          <>
            <div className="text-5xl" aria-hidden="true">⌛</div>
            <h1 className="mt-3 text-xl font-bold">{t("q8b.wl.leaveTitle")}</h1>
            <p className="mt-2 text-sm text-slate-600">{t("q8b.wl.leaveGone")}</p>
          </>
        ) : (
          <>
            <div className="text-5xl" aria-hidden="true">📋</div>
            <h1 className="mt-3 text-xl font-bold">{t("q8b.wl.leaveTitle")}</h1>
            {entry && (
              <p className="mt-2 text-sm text-slate-700">
                <span className="font-semibold">{entry.what}</span>
                {entry.venueName && <> · {entry.venueName}</>}
                {when && (
                  <>
                    <br />
                    {when}
                  </>
                )}
              </p>
            )}
            <p className="mt-2 text-sm text-slate-600">{t("q8b.wl.leaveBody")}</p>
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-600">
                {error}
              </p>
            )}
            <button
              onClick={leave}
              disabled={busy}
              className="mt-5 w-full rounded-lg border border-red-300 py-2.5 font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              {busy ? t("q8b.wl.leaving") : t("q8b.wl.leaveButton")}
            </button>
          </>
        )}
        <Link href="/" className="mt-5 inline-block text-sm font-medium text-teal-700 underline">
          {t("q8b.wl.home")}
        </Link>
      </div>
    </div>
  );
}
