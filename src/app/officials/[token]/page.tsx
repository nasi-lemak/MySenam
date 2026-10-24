"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { MatchResultForm } from "@/components/MatchResultForm";
import { translateError } from "@/lib/i18n";
import { formatMinute } from "@/lib/interval";
import { scoreExample } from "@/lib/result-text";
import type { Official } from "@/lib/match-reports";
import type { TournamentDetail } from "@/lib/tournaments";

/**
 * An official's page: the link the venue gave them is the key, no account
 * needed. The tournament's matches waiting for a result, in time order, each
 * with a result form; what they enter is recorded with their name.
 */
export default function OfficialPage() {
  const t = useT();
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<{ official: Official; tournament: TournamentDetail } | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/officials/${token}`, { cache: "no-store" });
    if (!res.ok) return setGone(true);
    setData(await res.json());
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);

  if (gone) return <p className="text-slate-600">{t("official.gone")}</p>;
  if (!data) return null;
  const x = data.tournament;
  const names = new Map(x.entries.map((e) => [e.id, e.name]));
  const waiting = x.matches
    .filter((m) => m.status === "scheduled" && m.a !== null && m.b !== null && (m.stage === "group" || m.stage === "knockout"))
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || (a.minute ?? 0) - (b.minute ?? 0));
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t("official.title", { name: x.name })}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {x.venueName} · {t("official.as", { name: data.official.name })}
        </p>
      </div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div>}
      {waiting.length === 0 ? (
        <p className="text-sm text-slate-500">{t("official.none")}</p>
      ) : (
        <ul className="space-y-3">
          {waiting.map((m) => (
            <li key={m.id} className="rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
              <div className="text-slate-500">
                {m.date} {m.minute !== null ? formatMinute(m.minute) : ""}, {m.courtName}
              </div>
              <div className="font-medium">
                {names.get(m.a!)} v {names.get(m.b!)}
              </div>
              <MatchResultForm
                t={t}
                sides={{ a: { id: m.a!, name: names.get(m.a!) ?? "" }, b: { id: m.b!, name: names.get(m.b!) ?? "" } }}
                drawAllowed={x.rules.scoring.kind === "tally" && x.rules.scoring.draws && m.stage === "group"}
                scoreHint={scoreExample(x)}
                onSubmit={async (r) => {
                  setError(null);
                  setNotice(null);
                  const res = await fetch(`/api/officials/${token}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ matchId: m.id, ...r }),
                  });
                  const out = await res.json();
                  if (!res.ok) return setError(translateError(t, out) || out.error);
                  setNotice(t("official.saved"));
                  setData({ ...data, tournament: out.tournament });
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
