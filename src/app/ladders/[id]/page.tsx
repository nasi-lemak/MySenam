"use client";

import { readJson } from "@/lib/read-response";
import { ActivityGlyph } from "@/components/Glyph";
import { accountDetour } from "@/lib/phone-detour";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { errorText, translateError } from "@/lib/i18n";
import type { ErrorCode, T } from "@/lib/i18n";
import type { ChallengeView, LadderDetail, MyPlace } from "@/lib/ladders";
import { CONFIRM_DAYS } from "@/lib/ladders-constants";

const button = "rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-40";
const plain = "rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-teal-500";
const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
const minutes = (value: string): number | undefined => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};
const clock = (m: number | null) => (m === null ? "" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

/**
 * One club ladder, for anybody: the ranks, the recent challenges, and an archive of earlier seasons. Signed in, a player joins, freezes
 * their place or leaves; sees who they may challenge and why not, challenges, answers, reports a result and confirms the other side's
 * (docs/features/tournaments.md#club-ladders). A guardian does it all for the child they entered.
 */
export default function LadderPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const [season, setSeason] = useState<number | null>(null);
  const [data, setData] = useState<{ ladder: LadderDetail; mine: MyPlace[]; people: { id: number; name: string }[]; signedIn: boolean } | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/ladders/${id}${season ? `?season=${season}` : ""}`, { cache: "no-store" });
    if (!res.ok) return setMissing(true);
    setData(await readJson(res));
  }, [id, season]);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(url: string, body: object): Promise<boolean> {
    setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await readJson(res);
    if (!res.ok && accountDetour(out)) return false;
    if (!res.ok) {
      setError(translateError(t, out) || out.error);
      return false;
    }
    await load();
    return true;
  }

  if (missing) return <p className="text-slate-500">{t("ldp.none")}</p>;
  if (!data) return null;
  const x = data.ladder;
  const viewing = x.viewing;
  const current = viewing !== null && viewing.endedOn === null;
  const names = new Map(x.rows.map((r) => [r.playerId, r.name]));
  const joinable = [...(data.mine.some((p) => p.participantId === null) ? [] : [{ id: "", name: t("ldp.myself") }]), ...(x.audience === "juniors" ? data.people.filter((p) => !data.mine.some((m) => m.participantId === p.id)).map((p) => ({ id: String(p.id), name: p.name })) : [])];
  const mineIds = new Set(data.mine.map((p) => p.playerId));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/ladders" className="text-sm text-teal-700 underline">
          ← {t("ldp.back")}
        </Link>
        <h1 className="mt-1 text-2xl font-bold">
          <ActivityGlyph sport={x.sport} /> {x.name}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          <Link href={`/venue/${x.venueId}`} className="underline">
            {x.venueName}
          </Link>
          {viewing && ` · ${t("ldp.season", { n: viewing.number })}`}
        </p>
        <p className="mt-1 text-sm text-slate-500">
          {t(`ldp.audience.${x.audience}`)} · {x.teamSize === 2 ? t("tour.doubles") : t("tour.singles")}
          {x.who !== "anyone" && ` · ${t(`who.badge.${x.who}`)}`}
          {x.level && ` · ${t(`games.level.${x.level}`)}`} · {t("ldp.players", { n: x.players })}
        </p>
        {x.description && <p className="mt-3 whitespace-pre-line text-sm text-slate-700">{x.description}</p>}
        {x.rated && <p className="mt-2 text-sm text-slate-600">{t("rt.ratedNote")}</p>}
        <p className="mt-3 text-sm text-slate-600">{t("ldp.how", { reach: x.settings.reach, respond: x.settings.respondDays, play: x.settings.playDays })}</p>
        {x.audience === "juniors" && <p className="mt-2 text-sm text-slate-600">{t("ldp.juniorNote")}</p>}
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {current && data.mine.map((p) => <PlaceCard key={p.playerId} t={t} x={x} p={p} post={post} />)}

      {current && x.status === "open" &&
        (data.signedIn ? (
          joinable.length > 0 && <JoinForm t={t} x={x} choices={joinable} onJoin={(input) => post(`/api/ladders/${x.id}`, { action: "join", ...input })} />
        ) : (
          <p className="text-sm text-slate-600">
            <Link href={`/login?next=/ladders/${x.id}`} className="text-teal-700 underline">
              {t("ldp.signIn")}
            </Link>
          </p>
        ))}
      {x.status === "closed" && <p className="text-sm text-slate-600">{t("ldp.closed")}</p>}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="font-semibold">{current ? t("ldp.ranks") : t("ldp.finalOrder")}</h2>
        <ol className="mt-2 divide-y divide-slate-100 text-sm">
          {x.rows.map((r) => (
            <li key={r.playerId} className={`flex flex-wrap items-baseline gap-x-3 py-1.5 ${mineIds.has(r.playerId) ? "font-semibold text-teal-800" : ""}`}>
              <span className="w-8 text-slate-500">{r.rank}</span>
              <span className="flex-1">{r.name}</span>
              {r.frozenUntil && <span className="text-xs text-slate-500">{t("ldp.frozenShort", { date: r.frozenUntil })}</span>}
              {r.inChallenge && <span className="text-xs text-amber-700">{t("ldp.inChallenge")}</span>}
            </li>
          ))}
        </ol>
      </section>

      {x.challenges.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">{t("ldp.recent")}</h2>
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {x.challenges.slice(0, 30).map((c) => (
              <li key={c.id} className="py-1.5">
                <span className="text-xs text-slate-500">{c.resolvedOn ?? c.createdOn} · </span>
                {summary(t, c, names)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {x.seasons.filter((s) => s.endedOn !== null).length > 0 && (
        <p className="text-sm text-slate-600">
          {t("ldp.archive")}:{" "}
          {x.seasons
            .filter((s) => s.endedOn !== null)
            .map((s) => (
              <button key={s.id} onClick={() => setSeason(s.number)} className="mr-2 text-teal-700 underline">
                {t("ldp.season", { n: s.number })}
              </button>
            ))}
          {season !== null && (
            <button onClick={() => setSeason(null)} className="text-teal-700 underline">
              {t("ldp.ranks")}
            </button>
          )}
        </p>
      )}
    </div>
  );
}

/** A challenge in a line: who, how it ended. */
function summary(t: T, c: ChallengeView, names: Map<number, string>): string {
  const a = c.challengerName || names.get(c.challenger) || "";
  const b = c.challengedName || names.get(c.challenged) || "";
  if (c.status === "confirmed" || c.status === "walkover") {
    const winner = c.winner === c.challenger ? a : b;
    return c.forfeit || c.status === "walkover" ? t("ldp.forfeitLine", { a, b, winner }) : t("ldp.resultLine", { a, b, winner, score: c.score ?? "" });
  }
  return `${a} v ${b}: ${t(`ldp.cs.${c.status as "pending" | "accepted" | "reported" | "disputed" | "declined" | "cancelled" | "lapsed" | "void"}`)}`;
}

function PlaceCard({ t, x, p, post }: { t: T; x: LadderDetail; p: MyPlace; post: (url: string, body: object) => Promise<boolean> }) {
  const [until, setUntil] = useState("");
  const [proposal, setProposal] = useState<Record<number, { date: string; time: string }>>({});
  const base = `/api/ladders/${x.id}`;
  const reason = (code: string, vars?: Record<string, string | number>) => errorText(t, code as ErrorCode, vars);
  return (
    <section className="space-y-3 rounded-xl border border-teal-200 bg-teal-50/40 p-4" aria-label={p.name}>
      <h2 className="font-semibold">{p.rank !== null ? t("ldp.you", { name: p.name, rank: p.rank }) : p.name}</h2>
      {p.frozenUntil ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t("ldp.frozen", { date: p.frozenUntil })}</span>
          <button className={plain} onClick={() => void post(base, { action: "thaw", playerId: p.playerId })}>
            {t("ldp.thaw")}
          </button>
        </div>
      ) : (
        <>
          <div>
            <h3 className="text-sm font-medium">{t("ldp.mayChallenge")}</h3>
            {p.targets.length === 0 ? (
              <p className="text-sm text-slate-500">{t("ldp.noTargets")}</p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm">
                {p.targets.map((tg) => (
                  <li key={tg.playerId} className="flex flex-wrap items-center gap-2">
                    <span className="w-8 text-slate-500">{tg.rank}</span>
                    <span className="flex-1">{tg.name}</span>
                    {tg.not === null ? (
                      <>
                        <input
                          type="date"
                          aria-label={`${t("ldp.suggestDay")}: ${tg.name}`}
                          value={proposal[tg.playerId]?.date ?? ""}
                          onChange={(e) => setProposal({ ...proposal, [tg.playerId]: { date: e.target.value, time: proposal[tg.playerId]?.time ?? "" } })}
                          className={input}
                        />
                        <input
                          type="time"
                          aria-label={`${t("ldp.time")}: ${tg.name}`}
                          value={proposal[tg.playerId]?.time ?? ""}
                          onChange={(e) => setProposal({ ...proposal, [tg.playerId]: { date: proposal[tg.playerId]?.date ?? "", time: e.target.value } })}
                          className={input}
                        />
                        <button
                          className={button}
                          onClick={() =>
                            void post(base, { action: "challenge", playerId: p.playerId, target: tg.playerId, onDate: proposal[tg.playerId]?.date || undefined, minute: minutes(proposal[tg.playerId]?.time ?? "") })
                          }
                        >
                          {t("ldp.challenge")}
                        </button>
                      </>
                    ) : (
                      <span className="text-xs text-slate-500">{reason(tg.not.code, tg.not.vars)}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {p.open.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">{t("ldp.open")}</h3>
          <ul className="mt-1 space-y-3 text-sm">
            {p.open.map((c) => (
              <OpenChallenge key={c.id} t={t} x={x} p={p} c={c} post={post} />
            ))}
          </ul>
        </div>
      )}

      {p.history.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">{t("ldp.history")}</summary>
          <ul className="mt-1 space-y-1 text-sm">
            {p.history.map((c) => (
              <li key={c.id}>{summary(t, c, new Map())}</li>
            ))}
          </ul>
        </details>
      )}

      {!p.frozenUntil && (
        <div className="flex flex-wrap items-end gap-2 border-t border-teal-100 pt-3 text-sm">
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("ldp.freezeUntil")}
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className={input} />
          </label>
          <button className={plain} disabled={!until} onClick={() => void post(base, { action: "freeze", playerId: p.playerId, until })}>
            {t("ldp.freeze")}
          </button>
          <button className={plain} onClick={() => window.confirm(t("ldp.leaveConfirm")) && void post(base, { action: "leave", playerId: p.playerId })}>
            {t("ldp.leave")}
          </button>
        </div>
      )}
    </section>
  );
}

function OpenChallenge({ t, x, p, c, post }: { t: T; x: LadderDetail; p: MyPlace; c: MyPlace["open"][number]; post: (url: string, body: object) => Promise<boolean> }) {
  const url = `/api/ladders/${x.id}/challenges/${c.id}`;
  const mineIsChallenger = c.challenger === p.playerId;
  const other = mineIsChallenger ? c.challengedName : c.challengerName;
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [winner, setWinner] = useState("me");
  const [score, setScore] = useState("");
  const [note, setNote] = useState("");
  const [disputing, setDisputing] = useState(false);
  const waitingFor = c.status === "pending" ? (c.awaiting === "challenged" ? c.challenged : c.challenger) : null;
  const act = (body: object) => post(url, { version: c.version, ...body });
  const when = c.proposedOn ? `${c.proposedOn} ${clock(c.proposedMin)}` : "";
  const result = c.winner !== null ? `${c.winner === p.playerId ? t("ldp.iWon") : t("ldp.theyWon", { name: other })} ${c.score ?? ""}`.trim() : "";
  return (
    <li className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
      {c.status === "pending" && waitingFor === p.playerId && <p>{t("ldp.pendingMine", { name: other, date: c.respondBy ?? "" })}</p>}
      {c.status === "pending" && when && c.proposedBy !== p.playerId && <p>{t("ldp.counterMine", { name: other, date: c.proposedOn ?? "", time: clock(c.proposedMin) })}</p>}
      {c.status === "pending" && waitingFor !== p.playerId && <p>{t("ldp.pendingTheirs", { name: other, date: c.respondBy ?? "" })}</p>}
      {c.status === "pending" && when && c.proposedBy === p.playerId && <p>{t("ldp.counterTheirs", { name: other, date: c.proposedOn ?? "", time: clock(c.proposedMin), by: c.respondBy ?? "" })}</p>}
      {c.status === "accepted" && <p>{t("ldp.accepted", { name: other, date: c.playBy ?? "" })}</p>}
      {c.agreedOn && c.status !== "pending" && <p className="text-xs text-slate-500">{t("ldp.agreed", { date: c.agreedOn, time: clock(c.agreedMin) })}</p>}
      {c.contact && (
        <p className="text-xs text-slate-600">
          {t("ldp.contact", { name: c.contact.name })}:{" "}
          <a href={`tel:${c.contact.phone}`} className="underline">
            {c.contact.phone}
          </a>{" "}
          ·{" "}
          <a href={`https://wa.me/${c.contact.whatsapp}`} target="_blank" rel="noopener" className="underline">
            WhatsApp
          </a>
        </p>
      )}
      {c.status === "disputed" && <p className="text-amber-800">{t("ldp.disputed")}</p>}
      {c.status === "reported" && c.reportedBy === p.playerId && <p>{t("ldp.waitingConfirm", { result, name: other, days: CONFIRM_DAYS })}</p>}
      {c.status === "reported" && c.reportedBy !== p.playerId && <p>{t("ldp.theyReported", { name: other, result })}</p>}

      <div className="flex flex-wrap items-end gap-2">
        {waitingFor === p.playerId && (
          <>
            <button className={button} onClick={() => void act({ action: "accept" })}>
              {t("ldp.accept")}
            </button>
            {!mineIsChallenger && (
              <button className={plain} onClick={() => void act({ action: "decline" })}>
                {t("ldp.decline")}
              </button>
            )}
            <input type="date" aria-label={t("ldp.day")} value={date} onChange={(e) => setDate(e.target.value)} className={input} />
            <input type="time" aria-label={t("ldp.time")} value={time} onChange={(e) => setTime(e.target.value)} className={input} />
            <button className={plain} disabled={!date} onClick={() => void act({ action: "propose", onDate: date, minute: minutes(time) })}>
              {t("ldp.propose")}
            </button>
          </>
        )}
        {mineIsChallenger && (c.status === "pending" || c.status === "accepted") && (
          <button className={plain} onClick={() => void act({ action: "withdraw" })}>
            {t("ldp.withdraw")}
          </button>
        )}
        {c.status === "reported" && c.reportedBy !== p.playerId && !disputing && (
          <>
            <button className={button} onClick={() => void act({ action: "confirm" })}>
              {t("ldp.confirm")}
            </button>
            <button className={plain} onClick={() => setDisputing(true)}>
              {t("ldp.dispute")}
            </button>
          </>
        )}
        {disputing && (
          <>
            <input aria-label={t("ldp.disputeNote")} placeholder={t("ldp.disputeNote")} value={note} onChange={(e) => setNote(e.target.value)} className={input} />
            <button className={button} disabled={note.trim().length < 3} onClick={() => void act({ action: "dispute", note })}>
              {t("ldp.send")}
            </button>
          </>
        )}
      </div>

      {(c.status === "accepted" || (c.status === "reported" && c.reportedBy === p.playerId)) && (
        <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2">
          <span className="w-full text-xs font-medium text-slate-500">{t("ldp.report")}</span>
          <select aria-label={t("ldp.winner")} value={winner} onChange={(e) => setWinner(e.target.value)} className={input}>
            <option value="me">{t("ldp.iWon")}</option>
            <option value="them">{t("ldp.theyWon", { name: other })}</option>
          </select>
          <input aria-label={t("ldp.score")} placeholder="21-15, 18-21, 21-10" value={score} onChange={(e) => setScore(e.target.value)} className={`w-44 ${input}`} />
          <button className={button} disabled={score.trim().length < 3} onClick={() => void act({ action: "report", winner: winner === "me" ? p.playerId : mineIsChallenger ? c.challenged : c.challenger, score })}>
            {t("ldp.send")}
          </button>
        </div>
      )}
    </li>
  );
}

function JoinForm({ t, x, choices, onJoin }: { t: T; x: LadderDetail; choices: { id: string; name: string }[]; onJoin: (input: Record<string, unknown>) => Promise<boolean> }) {
  const [who, setWho] = useState(choices[0]?.id ?? "");
  const [adult, setAdult] = useState(false);
  const [partner, setPartner] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await onJoin({ ...(who ? { participantId: Number(who) } : {}), ...(x.audience === "adults" ? { adult } : {}), ...(x.teamSize === 2 ? { partnerName: partner } : {}) });
      }}
      className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h2 className="w-full font-semibold">{t("ldp.join")}</h2>
      {choices.length > 1 && (
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("ldp.joinWho")}
          <select value={who} onChange={(e) => setWho(e.target.value)} className={input}>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {x.teamSize === 2 && (
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("ldp.partner")}
          <input required value={partner} onChange={(e) => setPartner(e.target.value)} className={input} />
        </label>
      )}
      {x.audience === "adults" && (
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
          {t("ldp.adult")}
        </label>
      )}
      <button className={button}>{t("ldp.joinBtn")}</button>
    </form>
  );
}
