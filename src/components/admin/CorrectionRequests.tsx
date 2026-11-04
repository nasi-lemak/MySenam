"use client";

import { useState } from "react";
import { readJson } from "@/lib/read-response";
import type { CorrectionRequest } from "@/lib/official-performances";
import type { TournamentDetail } from "@/lib/tournaments";
import type { StaffText } from "@/lib/staff-text";
import { ManagerOnly } from "./StaffMay";
import { useStaffT } from "./StaffLanguage";

const small = "rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:border-teal-500";
const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";

type Preview = { changes: string[]; changePhrases?: StaffText[]; consequential: boolean; token: string };

/**
 * What the officials of a climbing event asked to have corrected in a round that is finished (lib/official-performances.ts): who asked, why,
 * and the manager's way through the correction flow: preview what it changes, apply it only as previewed, or decline it with a reason.
 */
export function CorrectionRequests({
  tn,
  requests,
  base,
  reload,
  onTournament,
}: {
  tn: TournamentDetail;
  requests: CorrectionRequest[];
  base: string;
  reload: () => Promise<void>;
  onTournament?: (d: TournamentDetail) => void;
}) {
  const t = useStaffT();
  const [previews, setPreviews] = useState<Record<number, Preview>>({});
  const [declining, setDeclining] = useState<number | null>(null);
  const [why, setWhy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const roundName = (matchId: number) => {
    const m = tn.matches.find((x) => x.id === matchId);
    return !m ? "" : m.stage === "final" ? t("tn.perf.final") : t("tn.cp.group", { n: m.position });
  };

  async function act(id: number, body: object): Promise<Record<string, unknown> | null> {
    setError(null);
    const res = await fetch(`${base}/correction-requests/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await readJson(res);
    if (!res.ok) {
      setError(t.err(out));
      return null;
    }
    return out;
  }

  if (requests.length === 0) return null;
  return (
    <div className="mt-3" aria-label={t("ofs1.cr.title")}>
      <h4 className="font-medium">{t("ofs1.cr.title")}</h4>
      {error && <p className="mt-1 text-red-700">{error}</p>}
      <ul className="mt-1 space-y-2">
        {requests.map((r) => {
          const p = previews[r.id];
          return (
            <li key={r.id} className={`rounded-md border p-2 ${r.status === "open" ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-slate-50"}`}>
              <p>{t("ofs1.cr.line", { who: r.officialName, round: roundName(r.matchId), reason: r.reason })}</p>
              <p className="text-xs text-slate-600">
                {t(`ofs1.cr.status.${r.status}`)}
                {r.decidedBy ? ` · ${r.decidedBy}` : ""}
                {r.decisionNote ? ` · ${r.decisionNote}` : ""}
              </p>
              {r.status === "open" && (
                <ManagerOnly may="correctionRequestDecide">
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <button
                      className={small}
                      onClick={async () => {
                        const out = await act(r.id, { action: "preview" });
                        if (out) setPreviews({ ...previews, [r.id]: out.preview as Preview });
                      }}
                    >
                      {t("ofs1.cr.preview")}
                    </button>
                    <button className={small} aria-expanded={declining === r.id} onClick={() => setDeclining(declining === r.id ? null : r.id)}>
                      {t("ofs1.cr.decline")}
                    </button>
                  </div>
                  {p && (
                    <div className="mt-1 rounded-md bg-white p-2 text-xs">
                      {p.changes.length === 0 ? (
                        <p>{t("ofs1.cr.noChange")}</p>
                      ) : (
                        <>
                          <p className="font-medium">{t("ofs1.cr.changes")}</p>
                          <ul className="list-disc pl-4">
                            {p.changes.map((c, i) => (
                              <li key={i}>{t.say(p.changePhrases?.[i], c)}</li>
                            ))}
                          </ul>
                        </>
                      )}
                      {p.consequential && <p className="mt-1 font-medium text-amber-900">{t("ofs1.cr.field")}</p>}
                      <button
                        className={`${small} mt-1`}
                        onClick={async () => {
                          const out = await act(r.id, { action: "apply", token: p.token });
                          if (!out) return;
                          setPreviews({});
                          if (out.tournament) onTournament?.(out.tournament as TournamentDetail);
                          await reload();
                        }}
                      >
                        {t("ofs1.cr.apply")}
                      </button>
                    </div>
                  )}
                  {declining === r.id && (
                    <form
                      className="mt-1 flex flex-wrap items-end gap-2"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const out = await act(r.id, { action: "decline", note: why });
                        if (!out) return;
                        setDeclining(null);
                        setWhy("");
                        await reload();
                      }}
                    >
                      <label className="flex flex-col text-xs font-medium text-slate-500">
                        {t("ofs1.cr.declineWhy")}
                        <input required minLength={3} maxLength={300} value={why} onChange={(e) => setWhy(e.target.value)} className={`w-64 ${input}`} />
                      </label>
                      <button className={small}>{t("ofs1.cr.declineSend")}</button>
                    </form>
                  )}
                </ManagerOnly>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
