"use client";

import { readJson } from "@/lib/read-response";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { contextTitle } from "@/lib/message-titles";
import type { MessageSettings, ThreadSummary } from "@/lib/messages";
import { Thread } from "./Thread";

const FAMILIES = [
  ["game", ["game"]],
  ["team", ["team", "team_fixture"]],
  ["group", ["group"]],
  ["match", ["tournament_match", "league_match", "ladder_challenge"]],
] as const;

/**
 * Messages between players (docs/features/player-messages.md): the first screen that says what they are, then the signed-in player's
 * conversations grouped by what they belong to, each with its unread count. A conversation is opened by `?open=game:12`, the form the
 * links on game, team and group pages and the notice email take. Nothing is a directory: only contexts the player is in are ever listed.
 */
export default function MessagesPage() {
  const t = useT();
  const [data, setData] = useState<{ settings: MessageSettings; threads: ThreadSummary[]; unread: number } | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [open, setOpen] = useState<{ kind: string; id: number } | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/messages", { cache: "no-store" });
    if (res.status === 401) return setSignedOut(true);
    if (res.ok) setData(await readJson(res));
  }, []);

  useEffect(() => {
    void load();
    const wanted = new URLSearchParams(window.location.search).get("open");
    const m = wanted ? /^([a-z-]+):(\d+)$/.exec(wanted) : null;
    if (m) setOpen({ kind: m[1], id: Number(m[2]) });
  }, [load]);

  // The list refreshes while it is on screen and the tab is visible: polling, no sockets.
  useEffect(() => {
    if (open) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    return () => clearInterval(timer);
  }, [open, load]);

  async function save(patch: { enabled?: boolean; emailNotices?: boolean }) {
    setError(null);
    const res = await fetch("/api/messages/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...patch, ...(patch.enabled ? { understood: true } : {}) }),
    });
    const body = await readJson(res).catch(() => null);
    if (!res.ok) return setError(translateError(t, body));
    await load();
  }

  if (signedOut)
    return (
      <Link href="/login?next=/messages" className="text-teal-700 underline">
        {t("games.signInToJoin")}
      </Link>
    );
  if (!data) return null;
  const { settings, threads } = data;

  if (open && settings.enabled)
    return (
      <Thread
        kind={open.kind}
        id={open.id}
        onBack={() => {
          setOpen(null);
          window.history.replaceState(null, "", "/messages");
          void load();
        }}
      />
    );

  if (!settings.enabled)
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-bold">{t("pmsg.title")}</h1>
        <section aria-labelledby="pmsg-first" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
          <h2 id="pmsg-first" className="text-lg font-semibold text-slate-900">
            {t("pmsg.first.title")}
          </h2>
          <p>{t("pmsg.first.what")}</p>
          <p>{t("pmsg.first.private")}</p>
          <p>{t("pmsg.first.safe")}</p>
          <p>{t("pmsg.first.adults")}</p>
          <p>{t("pmsg.first.email")}</p>
          {settings.adult ? (
            <>
              {!settings.explained && (
                <label className="flex min-h-6 items-center gap-2 font-medium text-slate-900">
                  <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="h-5 w-5" />
                  {t("pmsg.first.understood")}
                </label>
              )}
              <button
                onClick={() => void save({ enabled: true })}
                disabled={!settings.explained && !understood}
                className="min-h-10 rounded-md bg-teal-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
              >
                {t("pmsg.first.turnOn")}
              </button>
            </>
          ) : (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900">
              {t("pmsg.first.needAdult")}{" "}
              <Link href="/games/preferences" className="font-semibold underline">
                {t("pmsg.first.preferences")}
              </Link>
            </p>
          )}
          {error && (
            <p role="alert" className="text-red-600">
              {error}
            </p>
          )}
        </section>
      </div>
    );

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t("pmsg.title")}</h1>
        <p className="text-sm text-slate-600">{t("pmsg.intro")}</p>
      </header>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {threads.length === 0 && <p className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-600">{t("pmsg.list.none")}</p>}
      {FAMILIES.map(([family, kinds]) => {
        const rows = threads.filter((th) => (kinds as readonly string[]).includes(th.info.kind));
        if (rows.length === 0) return null;
        return (
          <section key={family} aria-labelledby={`pmsg-f-${family}`}>
            <h2 id={`pmsg-f-${family}`} className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
              {t(`pmsg.what.${family}`)}
            </h2>
            <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
              {rows.map((th) => (
                <li key={`${th.kind}:${th.id}`}>
                  <button
                    onClick={() => {
                      setOpen({ kind: th.kind, id: th.id });
                      window.history.replaceState(null, "", `/messages?open=${th.kind}:${th.id}`);
                    }}
                    className="flex min-h-12 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-slate-50"
                  >
                    <span className="font-medium text-slate-900">{contextTitle(t, th.info)}</span>
                    <span className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      {th.phase !== "open" && <span>{t("pmsg.list.ended")}</span>}
                      {th.muted && <span>{t("pmsg.list.muted")}</span>}
                      <span>{t.plural("pmsg.people", th.people)}</span>
                      {th.unread > 0 && <span className="rounded-full bg-teal-600 px-2 py-0.5 font-semibold text-white">{t("pmsg.list.new", { n: th.unread })}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <p className="text-slate-700">{t("pmsg.on")}</p>
        <label className="flex min-h-6 items-center gap-2">
          <input type="checkbox" checked={settings.emailNotices} onChange={(e) => void save({ emailNotices: e.target.checked })} className="h-5 w-5" />
          {t("pmsg.emailMe")}
        </label>
        <button onClick={() => void save({ enabled: false })} className="min-h-9 rounded-md px-1 text-slate-600 underline hover:text-teal-700">
          {t("pmsg.turnOff")}
        </button>
      </section>
    </div>
  );
}
