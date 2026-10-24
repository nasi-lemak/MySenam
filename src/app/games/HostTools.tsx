"use client";

import { useState } from "react";
import type { T } from "@/lib/i18n";
import type { OpenGame } from "@/lib/games";
import type { PlayerSuggestion } from "@/lib/matchmaking";
import { reasonText } from "./Suggested";

type Act = (url: string, body: object, done?: string) => Promise<void>;

/**
 * A host's tools for one open game beyond saying yes or no: players who might
 * suit it (only those who opted in), inviting by email, a link to share, and
 * calling the game off.
 */
export function HostTools({ t, g, act }: { t: T; g: OpenGame; act: Act }) {
  const [candidates, setCandidates] = useState<PlayerSuggestion[] | null>(null);
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const small = "rounded-md border border-slate-300 px-2 py-0.5 text-xs font-medium hover:border-teal-500";
  if (g.status !== "open") return null;

  async function showCandidates() {
    const res = await fetch(`/api/games/${g.id}/candidates`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) return setError(data.error);
    setCandidates(data.players);
  }

  async function makeLink() {
    setError(null);
    const res = await fetch(`/api/games/${g.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "link", hours: 72 }) });
    const data = await res.json();
    if (!res.ok) return setError(data.error);
    setLink(data);
  }

  return (
    <div className="mt-2 space-y-2 border-t border-slate-100 pt-2" data-testid={`host-tools-${g.id}`}>
      {error && <p className="text-xs text-red-700">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void showCandidates()} className={small}>
          {t("games.suggestedPlayers")}
        </button>
        <button onClick={() => void makeLink()} className={small}>
          {t("games.shareLink")}
        </button>
        <button onClick={() => void act(`/api/games/${g.id}`, { action: "unlink" })} className={small}>
          {t("games.unlink")}
        </button>
        <button onClick={() => void act(`/api/games/${g.id}`, { action: "cancel" }, t("games.cancelledGame"))} className={`${small} text-red-700`}>
          {t("games.cancelGame")}
        </button>
      </div>
      {link && (
        <p className="text-xs text-slate-600">
          {t("games.linkMade", { time: link.expiresAt.slice(0, 16) })}{" "}
          <input readOnly value={link.url} onFocus={(e) => e.target.select()} className="w-full rounded border border-slate-200 px-1 py-0.5 font-mono" data-testid="game-link" />
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(`/api/games/${g.id}`, { action: "invite", email }, t("games.inviteSent")).then(() => setEmail(""));
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          type="email"
          required
          placeholder={t("games.inviteEmail")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs"
          name="inviteEmail"
        />
        <button className={small}>{t("games.invite")}</button>
      </form>
      {candidates &&
        (candidates.length === 0 ? (
          <p className="text-xs text-slate-500">{t("games.noCandidates")}</p>
        ) : (
          <ul className="space-y-1" data-testid="candidates">
            {candidates.map((c) => (
              <li key={c.userId} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">
                  {c.name} ({t(`games.level.${c.level}`)}){c.withinKm !== null && ` · ${t("games.withinKm", { km: c.withinKm })}`}
                </span>
                <span className="text-slate-500">{c.reasons.map((r) => reasonText(t, r)).join(" · ")}</span>
                <button
                  onClick={() =>
                    void act(`/api/games/${g.id}`, { action: "invite", userId: c.userId }, t("games.inviteSent")).then(() =>
                      setCandidates((list) => list?.filter((x) => x.userId !== c.userId) ?? null)
                    )
                  }
                  className={small}
                >
                  {t("games.invite")}
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

/** Block or report somebody in a game: shown to its host beside each player, and to players beside the host. */
export function SafetyButtons({ t, userId, gameId, done }: { t: T; userId: number; gameId: number; done: (msg: string | null, error?: string) => void }) {
  const [reporting, setReporting] = useState(false);
  const small = "rounded-md border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-500 hover:border-red-400";
  async function send(url: string, body: object, ok: string) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    done(res.ok ? ok : null, res.ok ? undefined : data.error);
  }
  return (
    <span className="inline-flex items-center gap-1">
      <button onClick={() => void send("/api/players/blocks", { userId }, t("games.blockedDone"))} className={small}>
        {t("games.block")}
      </button>
      {reporting ? (
        <select
          autoFocus
          defaultValue=""
          onChange={(e) => {
            setReporting(false);
            if (e.target.value) void send("/api/players/reports", { userId, gameId, reason: e.target.value }, t("games.reportDone"));
          }}
          className="rounded border border-slate-300 text-[11px]"
          aria-label={t("games.reportReason")}
        >
          <option value="">{t("games.reportReason")}</option>
          {(["no_show", "abuse", "spam", "safety", "other"] as const).map((r) => (
            <option key={r} value={r}>
              {t(`games.reason.${r}`)}
            </option>
          ))}
        </select>
      ) : (
        <button onClick={() => setReporting(true)} className={small}>
          {t("games.report")}
        </button>
      )}
    </span>
  );
}
