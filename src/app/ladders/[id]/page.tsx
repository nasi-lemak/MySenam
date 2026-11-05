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
import type { RubberKind } from "@/lib/competition-templates";
import { CONFIRM_DAYS } from "@/lib/ladders-constants";
import { MessagesLink } from "@/components/MessagesLink";
import { AgreeAfterLook } from "@/components/HoldAgreement";

const button = "rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-40";
const plain = "rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-teal-500";
const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
const minutes = (value: string): number | undefined => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};
const clock = (m: number | null) => (m === null ? "" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

/**
 * One club ladder, for anybody: the ranks, the decided results (never a challenge that is open or ended any other way), and an archive of earlier seasons. Signed in, a player joins, freezes
 * their place or leaves; sees who they may challenge and why not, challenges, answers, reports a result and confirms the other side's
 * (docs/features/tournaments.md#club-ladders). A guardian does it all for the child they entered.
 */
export default function LadderPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const [season, setSeason] = useState<number | null>(null);
  const [data, setData] = useState<{ ladder: LadderDetail; mine: MyPlace[]; people: { id: number; name: string }[]; signedIn: boolean; teams?: { id: number; name: string }[] } | null>(null);
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
          {x.kind === "teams" ? t("lad2.ui.audienceTeams") : `${t(`ldp.audience.${x.audience}`)} · ${x.teamSize === 2 ? t("tour.doubles") : t("tour.singles")}`}
          {x.who !== "anyone" && ` · ${t(`who.badge.${x.who}`)}`}
          {x.level && ` · ${t(`games.level.${x.level}`)}`} · {t("ldp.players", { n: x.players })}
        </p>
        {x.description && <p className="mt-3 whitespace-pre-line text-sm text-slate-700">{x.description}</p>}
        {x.rated && <p className="mt-2 text-sm text-slate-600">{t("rt.ratedNote")}</p>}
        <p className="mt-3 text-sm text-slate-600">{t("ldp.how", { reach: x.settings.reach, respond: x.settings.respondDays, play: x.settings.playDays })}</p>
        {x.audience === "juniors" && <p className="mt-2 text-sm text-slate-600">{t("ldp.juniorNote")}</p>}
        {x.team && <p className="mt-2 text-sm text-slate-600">{t("lad2.ui.teamsNote", { games: x.team.rubbers.map((k) => t(`lad2.ui.kind.${k}`)).join(", ") })}</p>}
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {current && data.mine.map((p) => <PlaceCard key={p.playerId} t={t} x={x} p={p} post={post} />)}

      {current && x.status === "open" &&
        (data.signedIn ? (
          x.kind === "teams" ? (
            <JoinTeamForm t={t} teams={(data.teams ?? []).filter((tm) => !data.mine.some((m) => m.name === tm.name))} onJoin={(teamId) => post(`/api/ladders/${x.id}`, { action: "join_team", teamId })} />
          ) : (
            joinable.length > 0 && <JoinForm t={t} x={x} choices={joinable} onJoin={(input) => post(`/api/ladders/${x.id}`, { action: "join", ...input })} />
          )
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
            </li>
          ))}
        </ol>
      </section>

      {x.results.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">{t("ldp.recent")}</h2>
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {x.results.slice(0, 30).map((r, i) => (
              <li key={i} className="py-1.5">
                {r.on && <span className="text-xs text-slate-500">{r.on} · </span>}
                {t("ldp.publicResult", { winner: r.winnerName, loser: r.loserName, score: r.score ?? "" }).trim()}
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

/** A player's own challenge in a line: who, how it ended (the public is shown decided results only, `LadderDetail.results`). */
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
      <MessagesLink kind="ladder-challenge" id={c.id} what="match" />
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
      {c.status === "accepted" && <ChallengeCourt t={t} x={x} p={p} c={c} url={url} post={post} other={other} />}
      {x.kind === "teams" && x.team && <TeamMatch t={t} x={x} p={p} c={c} url={url} post={post} />}
      {c.status === "disputed" && <p className="text-amber-800">{t("ldp.disputed")}</p>}
      {c.status === "reported" && c.reportedBy === p.playerId && <p>{t("ldp.waitingConfirm", { result, name: other, days: CONFIRM_DAYS })}</p>}
      {c.status === "reported" && c.reportedBy !== p.playerId && <p>{t("ldp.theyReported", { name: other, result })}</p>}

      <div className="flex flex-wrap items-end gap-2">
        {waitingFor === p.playerId && (
          <>
            {x.courtTime.on && c.status === "pending" && c.proposedBy !== null && c.proposedBy !== p.playerId && c.proposedOn && c.proposedMin !== null ? (
              // A time the other side proposed, and the venue holds the court: see the court, the time, what it costs and what it means before agreeing it (ADR 0050).
              <AgreeAfterLook
                t={t}
                url={url}
                kind="accept"
                name={other}
                check={t("lad4.ui.check")}
                go={t("lad4.ui.go")}
                onGo={(courtId) => act({ action: "accept", ...(courtId === null ? {} : { courtId }) })}
              />
            ) : (
              <button className={button} onClick={() => void act({ action: "accept" })}>
                {t("ldp.accept")}
              </button>
            )}
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

      {x.kind !== "teams" && (c.status === "accepted" || (c.status === "reported" && c.reportedBy === p.playerId)) && (
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

/**
 * The court for an accepted challenge. None is held: the players book through the venue's ordinary booking page, then add that booking's code
 * here so both see it; adding changes nothing about the booking.
 */
function ChallengeCourt({ t, x, p, c, url, post, other }: { t: T; x: LadderDetail; p: MyPlace; c: MyPlace["open"][number]; url: string; post: (url: string, body: object) => Promise<boolean>; other: string }) {
  const [code, setCode] = useState("");
  if (c.booking)
    return (
      <div className="space-y-1 text-sm">
        <p className="font-medium">{t("ofc1.lb.booked", { court: c.booking.court, date: c.booking.date, time: clock(c.booking.startMin) })}</p>
        <button className={plain} onClick={() => void post(url, { action: "detach_booking" })}>
          {t("ofc1.lb.detach")}
        </button>
      </div>
    );
  return (
    <div className="space-y-1 text-sm">
      {x.courtTime.on && <HeldCourt t={t} p={p} c={c} url={url} post={post} other={other} />}
      {!c.hold && <p className="text-xs text-slate-600">{t("ofc1.lb.none")}</p>}
      {!c.hold && (
      <div className="flex flex-wrap items-end gap-2">
        <Link href={`${p.bookingPage}${c.agreedOn ? `&date=${c.agreedOn}` : ""}`} className={plain}>
          {t("ofc1.lb.book")}
        </Link>
        <input aria-label={t("ofc1.lb.code")} placeholder={t("ofc1.lb.code")} value={code} onChange={(e) => setCode(e.target.value)} className={`w-40 ${input}`} />
        <button className={button} disabled={code.trim().length < 3} onClick={() => void post(url, { action: "attach_booking", code }).then((ok) => ok && setCode(""))}>
          {t("ofc1.lb.attach")}
        </button>
      </div>
      )}
    </div>
  );
}

/**
 * A ladder that holds court time: the court the venue holds for an accepted challenge (nothing is charged), or, until a day and time are agreed, a
 * way to agree one: one player asks, the other agrees, and the venue holds a court (docs/features/tournaments.md#court-time-and-booking-for-a-challenge).
 */
function HeldCourt({ t, p, c, url, post, other }: { t: T; p: MyPlace; c: MyPlace["open"][number]; url: string; post: (url: string, body: object) => Promise<boolean>; other: string }) {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const act = (body: object) => post(url, { version: c.version, ...body });
  return (
    <div className="space-y-1">
      <p className="font-medium">{c.hold ? t("lad2.ui.held", { court: c.hold.court, date: c.hold.date, time: clock(c.hold.startMin) }) : t("lad2.ui.notHeld", { name: other })}</p>
      {c.hold?.agreed && !c.hold.tentative && <p className="text-xs text-slate-600">{t("lad4.ui.agreedNote")}</p>}
      {c.hold?.changed && c.hold.tentative && <p className="text-xs text-amber-800">{t("lad4.ui.changedNote", { oldCourt: c.hold.changed.court ?? "", oldDate: c.hold.changed.date, oldTime: clock(c.hold.changed.startMin) })}</p>}
      {c.hold?.tentative && (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {(c.challenger === p.playerId ? c.hold.confirmedBy.challenger : c.hold.confirmedBy.challenged)
              ? t("lad3.ui.waitingOther", { name: other, by: c.hold.confirmBy ? new Date(c.hold.confirmBy).toLocaleString() : "" })
              : t("lad3.ui.confirmBy", { by: c.hold.confirmBy ? new Date(c.hold.confirmBy).toLocaleString() : "" })}
          </span>
          {!(c.challenger === p.playerId ? c.hold.confirmedBy.challenger : c.hold.confirmedBy.challenged) && (
            <button className={button} onClick={() => void act({ action: "confirm_hold" })}>
              {t("lad3.ui.confirm")}
            </button>
          )}
        </div>
      )}
      {c.move && (
        <div className="flex flex-wrap items-center gap-2">
          <span>{c.move.by === p.playerId ? t("lad2.ui.moveAskedByMe", { name: other, date: c.move.onDate, time: clock(c.move.minute) }) : t("lad2.ui.moveAskedOfMe", { name: other, date: c.move.onDate, time: clock(c.move.minute) })}</span>
          {c.move.by === p.playerId ? (
            <button className={plain} onClick={() => void act({ action: "withdraw_move" })}>
              {t("lad2.ui.takeBack")}
            </button>
          ) : (
            <>
              <AgreeAfterLook
                t={t}
                url={url}
                kind="agree_move"
                name={other}
                check={t("lad4.ui.checkAgree")}
                go={t("lad4.ui.goAgree")}
                onGo={(courtId) => act({ action: "agree_move", ...(courtId === null ? {} : { courtId }) })}
              />
              <button className={plain} onClick={() => void act({ action: "decline_move" })}>
                {t("lad2.ui.turnDown")}
              </button>
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <input type="date" aria-label={t("ldp.day")} value={date} onChange={(e) => setDate(e.target.value)} className={input} />
        <input type="time" aria-label={t("ldp.time")} value={time} onChange={(e) => setTime(e.target.value)} className={input} />
        {date && minutes(time) !== undefined ? (
          <AgreeAfterLook
            key={`${date} ${time}`}
            t={t}
            url={url}
            kind="propose_move"
            name={other}
            when={{ onDate: date, minute: minutes(time)! }}
            check={t("lad4.ui.checkAsk", { name: other })}
            go={t("lad4.ui.goAsk")}
            onGo={() => act({ action: "propose_move", onDate: date, minute: minutes(time) })}
          />
        ) : (
          <button className={plain} disabled onClick={undefined}>
            {t("lad2.ui.askTime", { name: other })}
          </button>
        )}
      </div>
    </div>
  );
}

/** A ladder of teams: the lineup this captain names, the games reported, and a forfeit asked for (a manager decides it). */
function TeamMatch({ t, x, p, c, url, post }: { t: T; x: LadderDetail; p: MyPlace; c: MyPlace["open"][number]; url: string; post: (url: string, body: object) => Promise<boolean> }) {
  const kinds = x.team?.rubbers ?? [];
  const team = c.team;
  const mySide = team?.mySide ?? (c.challenger === p.playerId ? "home" : "away");
  const roster = team?.roster ?? [];
  const named = (side: "home" | "away") => (team?.lineup ?? []).filter((l) => l.side === side);
  const [picks, setPicks] = useState<number[][]>(() => kinds.map((_, i) => named(mySide).filter((l) => l.rubber === i + 1 && l.memberId !== null).map((l) => l.memberId!)));
  const [games, setGames] = useState<{ winner: string; score: string; walkover: boolean }[]>(() => kinds.map(() => ({ winner: "home", score: "", walkover: false })));
  const [forfeit, setForfeit] = useState({ team: "", reason: "no_show", note: "" });
  const act = (body: object) => post(url, { version: c.version, ...body });
  const label = (k: RubberKind, i: number) => t("lad2.ui.game", { n: i + 1, kind: t(`lad2.ui.kind.${k}`) });
  const theirs = named(mySide === "home" ? "away" : "home");
  const open = (c.forfeitRequests ?? []).filter((r) => r.status === "open");
  return (
    <div className="space-y-3 border-t border-slate-100 pt-2">
      {c.status === "accepted" && roster.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-slate-500">{t("lad2.ui.yourLineup")}</legend>
          {kinds.map((k, i) => (
            <div key={i} className="flex flex-wrap items-center gap-x-3 text-sm">
              <span className="w-40 text-xs text-slate-500">{label(k, i)}</span>
              {roster.map((m) => (
                <label key={m.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={picks[i]?.includes(m.id) ?? false}
                    onChange={(e) => setPicks(picks.map((row, j) => (j === i ? (e.target.checked ? [...row, m.id] : row.filter((id) => id !== m.id)) : row)))}
                  />
                  {m.name || "—"}
                </label>
              ))}
            </div>
          ))}
          <button className={plain} onClick={() => void post(url, { action: "set_lineup", picks: picks.map((memberIds, i) => ({ rubber: i + 1, memberIds })) })}>
            {t("lad2.ui.saveLineup")}
          </button>
        </fieldset>
      )}
      {c.status !== "accepted" && named(mySide).length > 0 && (
        <p className="text-xs text-slate-600">
          {t("lad2.ui.yourLineup")}: {named(mySide).map((l) => `${l.rubber}. ${l.name || "—"}`).join(", ")}
        </p>
      )}
      {theirs.length > 0 && (
        <p className="text-xs text-slate-600">
          {t("lad2.ui.theirLineup")}: {theirs.map((l) => `${l.rubber}. ${l.name || "—"}`).join(", ")}
        </p>
      )}
      {(c.status === "accepted" || (c.status === "reported" && c.reportedBy === p.playerId)) && (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-slate-500">{t("lad2.ui.report")}</legend>
          {kinds.map((k, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-40 text-xs text-slate-500">{label(k, i)}</span>
              <select aria-label={`${label(k, i)}: ${t("ldp.winner")}`} value={games[i]?.winner} onChange={(e) => setGames(games.map((g, j) => (j === i ? { ...g, winner: e.target.value } : g)))} className={input}>
                <option value="home">{c.challengerName}</option>
                <option value="away">{c.challengedName}</option>
              </select>
              <input
                aria-label={`${label(k, i)}: ${t("ldp.score")}`}
                placeholder="21-15, 18-21, 21-10"
                value={games[i]?.score}
                onChange={(e) => setGames(games.map((g, j) => (j === i ? { ...g, score: e.target.value } : g)))}
                className={`w-44 ${input}`}
              />
            </div>
          ))}
          <button className={button} onClick={() => void act({ action: "report_team", rubbers: games.map((g) => ({ winner: g.winner, score: g.score })) })}>
            {t("ldp.send")}
          </button>
        </fieldset>
      )}
      {open.map((r) => (
        <p key={r.id} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          {t("lad2.ui.forfeitOpen", { by: r.by, team: r.forfeitTeam.name })}
          {r.mine && (
            <button className={plain} onClick={() => void post(url, { action: "withdraw_forfeit_request", requestId: r.id })}>
              {t("lad2.ui.forfeitWithdraw")}
            </button>
          )}
        </p>
      ))}
      {c.status === "accepted" && (
        <details>
          <summary className="cursor-pointer text-xs text-teal-700">{t("lad2.ui.forfeit")}</summary>
          <div className="mt-1 flex flex-wrap items-end gap-2 text-sm">
            <label className="flex flex-col text-xs font-medium text-slate-500">
              {t("lad2.ui.forfeitWho")}
              <select value={forfeit.team} onChange={(e) => setForfeit({ ...forfeit, team: e.target.value })} className={input}>
                <option value="" />
                <option value={c.challenger}>{c.challengerName}</option>
                <option value={c.challenged}>{c.challengedName}</option>
              </select>
            </label>
            <label className="flex flex-col text-xs font-medium text-slate-500">
              {t("ofc1.fr.reason")}
              <select value={forfeit.reason} onChange={(e) => setForfeit({ ...forfeit, reason: e.target.value })} className={input}>
                {(["no_show", "short_handed", "told_us", "other"] as const).map((r) => (
                  <option key={r} value={r}>
                    {t(`ofc1.fr.reason.${r}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-xs font-medium text-slate-500">
              {t("lad2.ui.forfeitNote")}
              <input maxLength={300} value={forfeit.note} onChange={(e) => setForfeit({ ...forfeit, note: e.target.value })} className={input} />
            </label>
            <button className={plain} disabled={!forfeit.team} onClick={() => void post(url, { action: "request_forfeit", forfeitPlayer: Number(forfeit.team), reason: forfeit.reason, note: forfeit.note || undefined })}>
              {t("lad2.ui.forfeitSend")}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}

function JoinTeamForm({ t, teams, onJoin }: { t: T; teams: { id: number; name: string }[]; onJoin: (teamId: number) => Promise<boolean> }) {
  const [team, setTeam] = useState(teams[0]?.id ?? 0);
  if (teams.length === 0)
    return (
      <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm">
        {t("lad2.ui.noTeams")}{" "}
        <Link href="/teams" className="text-teal-700 underline">
          {t("tm.ui.title")}
        </Link>
      </p>
    );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await onJoin(team);
      }}
      className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h2 className="w-full font-semibold">{t("lad2.ui.joinTeam")}</h2>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        {t("lad2.ui.joinTeamWho")}
        <select value={team} onChange={(e) => setTeam(Number(e.target.value))} className={input}>
          {teams.map((tm) => (
            <option key={tm.id} value={tm.id}>
              {tm.name}
            </option>
          ))}
        </select>
      </label>
      <button className={button}>{t("lad2.ui.joinTeamBtn")}</button>
    </form>
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
