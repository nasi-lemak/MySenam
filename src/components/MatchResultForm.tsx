"use client";

import { useState } from "react";
import type { T } from "@/lib/i18n";

/**
 * A match's result as the people on court give it: who won (or a draw,
 * where the rules allow one), the score from the first-named side's view,
 * or a walkover. Used by players reporting their own match and by officials.
 */
export function MatchResultForm({
  t,
  sides,
  drawAllowed,
  scoreHint,
  onSubmit,
}: {
  t: T;
  sides: { a: { id: number; name: string }; b: { id: number; name: string } };
  drawAllowed: boolean;
  /** How a score is written in this sport: "21-15, 18-21". */
  scoreHint: string;
  onSubmit: (result: { winner: number | null; score: string; walkover: boolean }) => Promise<void>;
}) {
  const [winner, setWinner] = useState("");
  const [score, setScore] = useState("");
  const [walkover, setWalkover] = useState(false);
  const [busy, setBusy] = useState(false);
  const field = "rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit({ winner: winner === "draw" ? null : Number(winner), score: walkover ? "" : score, walkover });
        } finally {
          setBusy(false);
        }
      }}
      className="mt-1 flex flex-wrap items-center gap-2"
    >
      <select required aria-label={t("result.winner")} value={winner} onChange={(e) => setWinner(e.target.value)} className={field}>
        <option value="">{t("result.winner")}</option>
        <option value={sides.a.id}>{sides.a.name}</option>
        <option value={sides.b.id}>{sides.b.name}</option>
        {drawAllowed && <option value="draw">{t("result.draw")}</option>}
      </select>
      {!walkover && (
        <input
          required
          aria-label={t("result.score")}
          placeholder={t("result.scoreHint", { first: sides.a.name, example: scoreHint })}
          value={score}
          onChange={(e) => setScore(e.target.value)}
          className={`w-56 ${field}`}
        />
      )}
      {winner !== "draw" && (
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <input type="checkbox" checked={walkover} onChange={(e) => setWalkover(e.target.checked)} />
          {t("result.walkover")}
        </label>
      )}
      <button disabled={busy} className="rounded-md bg-teal-600 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
        {t("result.save")}
      </button>
    </form>
  );
}
