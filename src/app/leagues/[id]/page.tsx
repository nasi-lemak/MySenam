"use client";

import { readJson } from "@/lib/read-response";
import { ActivityGlyph } from "@/components/Glyph";
import { accountDetour } from "@/lib/phone-detour";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import type { T } from "@/lib/i18n";

import type { LeagueDetail, LeagueMatch, MyLeague } from "@/lib/leagues";
import { MessagesLink } from "@/components/MessagesLink";

/**
 * One league, for anybody: what it is, the boxes and tables of a season, and
 * every result. Signed in, a player joins, pays and leaves here; and in their
 * own box sees how to reach the others, reports scores and answers reports.
 */
export default function LeaguePage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const [season, setSeason] = useState<number | null>(null);
  const [data, setData] = useState<{
    league: LeagueDetail;
    mine: MyLeague | null;
    /** Places this account holds for people it acts for, and those people. */
    managed?: MyLeague[];
    people?: { id: number; name: string }[];
    signedIn: boolean;
  } | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/leagues/${id}${season ? `?season=${season}` : ""}`, { cache: "no-store" });
    if (!res.ok) return setMissing(true);
    setData(await readJson(res));
  }, [id, season]);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(url: string, body: object) {
    setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await readJson(res);
    if (!res.ok && accountDetour(out)) return false;
    if (!res.ok) {
      setError(translateError(t, out) || out.error);
      return false;
    }
    if (out.url) {
      window.location.href = out.url;
      return true;
    }
    await load();
    return true;
  }

  if (missing) return <p className="text-slate-500">{t("leag.none")}</p>;
  if (!data) return null;
  const x = data.league;
  const mine = data.mine;
  const managed = data.managed ?? [];
  const names = new Map(x.people.map((p) => [p.id, p.name]));
  const played = x.seasons.filter((s) => s.status !== "forming");
  const viewingCurrent = x.viewing?.status === "running";
  const button = "rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700";
  // The places this account answers for: its own, and those it holds for people it acts for.
  const held = [...(mine ? [mine] : []), ...managed];
  const ours = new Set(viewingCurrent ? held.filter((p) => p.place).map((p) => p.playerId) : []);
  const joinable = [...(mine ? [] : [{ id: "", name: t("lg5.myself") }]), ...(data.people ?? []).filter((p) => !managed.some((m) => m.participantId === p.id)).map((p) => ({ id: String(p.id), name: p.name }))];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/leagues" className="text-sm text-teal-700 underline">
          ← {t("leag.title")}
        </Link>
        <h1 className="mt-1 text-2xl font-bold">
          <ActivityGlyph sport={x.sport} /> {x.name}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          <Link href={`/venue/${x.venueId}`} className="underline">
            {x.venueName}
          </Link>
          {x.current &&
            ` · ${
              x.current.status === "forming"
                ? t("leag.startsOn", { n: x.current.number, date: x.current.startsOn })
                : t("leag.running", { n: x.current.number, from: x.current.startsOn, to: x.current.endsOn })
            }`}
        </p>
        <p className="mt-1 text-sm text-slate-500">
          {x.who !== "anyone" && `${t(`who.badge.${x.who}`)} · `}
          {x.teamSize === 2 ? t("tour.doubles") : t("tour.singles")} · {t("leag.boxesOf", { n: x.boxSize })}
          {x.level && ` · ${t(`games.level.${x.level}`)}`} · {x.fee > 0 ? t("leag.fee", { amount: x.fee.toFixed(2) }) : t("leag.free")} ·{" "}
          {t("leag.players", { n: x.players })}
        </p>
        {x.description && <p className="mt-3 whitespace-pre-line text-sm text-slate-700">{x.description}</p>}
        {x.rated && <p className="mt-2 text-sm text-slate-600">{t("rt.ratedNote")}</p>}
        <p className="mt-3 text-sm text-slate-600">{t("leag.how")}</p>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {held.map((p) => (
        <PlaceCard key={p.playerId} t={t} x={x} p={p} own={p === mine} post={(body) => post(`/api/leagues/${x.id}`, body)} />
      ))}
      {x.status === "running" &&
        (data.signedIn ? (
          joinable.length > 0 && (
            <JoinForm
              t={t}
              teamSize={x.teamSize}
              who={x.who}
              choices={joinable}
              onJoin={(input) => post(`/api/leagues/${x.id}`, { action: "join", ...input })}
            />
          )
        ) : (
          <Link href={`/login?next=/leagues/${x.id}`} className={`inline-block ${button}`}>
            {t("leag.signInToJoin")}
          </Link>
        ))}

      {played.length > 1 && (
        <nav className="flex flex-wrap gap-2">
          {played.map((s) => (
            <button
              key={s.id}
              onClick={() => setSeason(s.number)}
              className={`rounded-full px-3 py-1 text-sm font-medium ${
                x.viewing?.id === s.id ? "bg-teal-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"
              }`}
            >
              {t("leag.season", { n: s.number })}
            </button>
          ))}
        </nav>
      )}

      {x.viewing && x.boxes.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">
            {t("leag.season", { n: x.viewing.number })}{" "}
            <span className="text-sm font-normal text-slate-500">
              {x.viewing.startsOn} – {x.viewing.endsOn}
            </span>
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {x.boxes.map((box) => {
              const isMine = viewingCurrent && held.some((p) => p.place?.boxNo === box.boxNo);
              return (
                <div key={box.boxNo} className={`rounded-xl border bg-white p-4 shadow-sm ${isMine ? "border-teal-400" : "border-slate-200"}`}>
                  <h3 className="font-semibold">{t("leag.box", { n: box.boxNo })}</h3>
                  <table className="mt-2 w-full text-sm">
                    <thead className="text-xs text-slate-500">
                      <tr>
                        <th className="text-left font-medium" />
                        <th className="w-8 font-medium">{t("tour.played")}</th>
                        <th className="w-8 font-medium">{t("tour.won")}</th>
                        <th className="w-8 font-medium">{t("tour.lost")}</th>
                        <th className="w-12 font-medium">{t("tour.sets")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {box.table.map((s) => {
                        const place = x.places.find((p) => p.playerId === s.entryId);
                        return (
                          <tr key={s.entryId} className={place?.withdrawn ? "text-slate-400 line-through" : ""}>
                            <td className="py-0.5">
                              {names.get(s.entryId)}
                              {place?.move === "up" && <span className="ml-1 text-xs text-emerald-700">▲ {t("leag.up")}</span>}
                              {place?.move === "down" && <span className="ml-1 text-xs text-red-700">▼ {t("leag.down")}</span>}
                            </td>
                            <td className="text-center">{s.played}</td>
                            <td className="text-center">{s.won}</td>
                            <td className="text-center">{s.lost}</td>
                            <td className="text-center">
                              {s.setDiff > 0 ? "+" : ""}
                              {s.setDiff}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <ul className="mt-3 divide-y divide-slate-100 text-sm">
                    {x.matches
                      .filter((m) => m.boxNo === box.boxNo)
                      .map((m) => (
                        <MatchRow
                          key={m.id}
                          t={t}
                          m={m}
                          names={names}
                          me={isMine ? ourSide(m, ours) : null}
                          post={(body) => post(`/api/leagues/${x.id}/matches/${m.id}`, body)}
                        />
                      ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {x.current?.status === "forming" && x.people.some((p) => p.status === "active") && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">
            {t("leag.signedUp")} · {t("leag.startsOn", { n: x.current.number, date: x.current.startsOn })}
          </h2>
          <ul className="mt-2 columns-2 text-sm">
            {x.people
              .filter((p) => p.status === "active")
              .map((p) => (
                <li key={p.id}>
                  {p.name}
                  {p.level && <span className="text-slate-400"> · {t(`games.level.${p.level}`)}</span>}
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The side of a match this account answers for: one of the places it holds, never both. */
function ourSide(m: LeagueMatch, ours: Set<number>): number | null {
  const a = ours.has(m.a);
  const b = ours.has(m.b);
  return a && b ? null : a ? m.a : b ? m.b : null;
}

/** A place the account holds, its own or one for somebody it acts for: its box, its fee, leaving, and box-mates' numbers. */
function PlaceCard({ t, x, p, own, post }: { t: T; x: LeagueDetail; p: MyLeague; own: boolean; post: (body: object) => Promise<boolean> }) {
  const button = "rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700";
  const which = own ? {} : { playerId: p.playerId };
  return (
    <section className="space-y-3 rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-medium text-teal-900">
          {own ? (p.place ? t("leag.yourBox", { n: p.place.boxNo }) : t("leag.youreIn")) : p.place ? t("lg5.inBox", { name: p.name, n: p.place.boxNo }) : t("lg5.inLeague", { name: p.name })}
          {!p.place && <span className="block font-normal text-teal-800">{t("leag.waitNext")}</span>}
        </span>
        <span className="flex flex-wrap items-center gap-3">
          {p.place &&
            x.fee > 0 &&
            (p.place.paid ? (
              <span className="font-semibold text-emerald-700">{t("leag.feePaid")}</span>
            ) : x.payOnline ? (
              <button onClick={() => void post({ action: "pay", ...which })} className={button}>
                {own ? t("leag.payFee", { amount: x.fee.toFixed(2) }) : t("fin5.leag.payFeeFor", { name: p.name, amount: x.fee.toFixed(2) })}
              </button>
            ) : (
              <span>{t("leag.payAtVenue", { amount: x.fee.toFixed(2) })}</span>
            ))}
          <button
            onClick={() => {
              if (window.confirm(t("leag.leaveConfirm"))) void post({ action: "leave", ...which });
            }}
            className="text-slate-600 underline"
          >
            {t("leag.leave")}
          </button>
        </span>
      </div>
      {p.contacts.length > 0 && (
        <div>
          <div className="font-medium text-teal-900">{t("leag.boxMates")}</div>
          <ul className="mt-1 space-y-1">
            {p.contacts.map((c) => (
              <li key={c.playerId} className="flex flex-wrap gap-x-3">
                <span className="min-w-[8rem]">{c.name}</span>
                <a href={`tel:${c.phone}`} className="text-teal-700 underline">
                  {c.phone}
                </a>
                <a href={`https://wa.me/${c.whatsapp}`} target="_blank" rel="noreferrer" className="text-teal-700 underline">
                  WhatsApp
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * Joining: the account holder, or somebody they act for (then that person's
 * gender, as declared, in a women's or men's league); in pairs, the partner's
 * name and, in a women's or men's league, their declared gender, checked as a
 * tournament's are.
 */
function JoinForm({
  t,
  teamSize,
  who,
  choices,
  onJoin,
}: {
  t: T;
  teamSize: 1 | 2;
  who: LeagueDetail["who"];
  choices: { id: string; name: string }[];
  onJoin: (input: { partnerName?: string; partnerGender?: string; participantId?: number; gender?: string }) => Promise<boolean>;
}) {
  const [partner, setPartner] = useState("");
  const [partnerGender, setPartnerGender] = useState("");
  const [picked, setPicked] = useState("");
  const [gender, setGender] = useState("");
  const chosen = choices.some((c) => c.id === picked) ? picked : choices[0].id;
  const forOther = chosen !== "";
  // Joining somebody they act for: their partner is asked about by their name, not "your".
  const theirName = forOther ? (choices.find((c) => c.id === chosen)?.name ?? "") : null;
  const field = "mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  const genders = (value: string, set: (v: string) => void) => (
    <select required value={value} onChange={(e) => set(e.target.value)} className={field}>
      <option value="">—</option>
      <option value="woman">{t("who.partnerWoman")}</option>
      <option value="man">{t("who.partnerMan")}</option>
    </select>
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onJoin({
          ...(teamSize === 2 ? { partnerName: partner, ...(who !== "anyone" ? { partnerGender } : {}) } : {}),
          ...(forOther ? { participantId: Number(chosen), ...(who !== "anyone" ? { gender } : {}) } : {}),
        });
      }}
      className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-end gap-3">
        {choices.length > 1 && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("lg5.whoJoins")}
            <select value={chosen} onChange={(e) => setPicked(e.target.value)} className={field}>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {forOther && who !== "anyone" && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("lg5.theyAre")}
            {genders(gender, setGender)}
          </label>
        )}
        {teamSize === 2 && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {theirName ? t("fin5.tour.partnerOf", { name: theirName }) : t("tour.partner")}
            <input required minLength={2} value={partner} onChange={(e) => setPartner(e.target.value)} className={field} />
          </label>
        )}
        {teamSize === 2 && who !== "anyone" && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {theirName ? t("fin5.who.partnerOf", { name: theirName }) : t("who.partner")}
            {genders(partnerGender, setPartnerGender)}
          </label>
        )}
        <button className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">{t("leag.join")}</button>
      </div>
      <p className="text-xs text-slate-500">{t(forOther ? "lg5.shareNoteFor" : "leag.shareNote")}</p>
    </form>
  );
}

/** "21-15, 18-21" from the other side: "15-21, 21-18". */
function flip(score: string): string {
  return score
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split(/\s*[-–:]\s*/).reverse().join("-"))
    .join(", ");
}

function MatchRow({
  t,
  m,
  names,
  me,
  post,
}: {
  t: T;
  m: LeagueMatch;
  names: Map<number, string>;
  /** The viewer's player, when this is their box in the season being played. */
  me: number | null;
  post: (body: object) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"idle" | "report" | "dispute">("idle");
  const [won, setWon] = useState(true);
  const [score, setScore] = useState("");
  const [note, setNote] = useState("");
  const mineMatch = me !== null && (m.a === me || m.b === me);
  const them = mineMatch ? (m.a === me ? m.b : m.a) : null;
  const side = (id: number) => <span className={m.winner === id && m.status !== "reported" ? "font-semibold" : ""}>{names.get(id)}</span>;
  const shownScore = m.status === "walkover" ? t("leag.status.walkover") : m.score;
  const input = "rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none";
  const small = "rounded-md bg-teal-600 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700";

  return (
    <li className="py-1.5">
      <div className="flex flex-wrap items-center gap-x-3">
        <span className="flex-1">
          {side(m.a)} v {side(m.b)}
        </span>
        {shownScore && <span className="text-slate-600">{shownScore}</span>}
        {m.status !== "confirmed" && m.status !== "walkover" && <span className="text-xs text-slate-400">{t(`leag.status.${m.status}`)}</span>}
      </div>
      {mineMatch && mode === "idle" && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <MessagesLink kind="league-match" id={m.id} what="match" />
          {m.status === "unplayed" && (
            <button onClick={() => setMode("report")} className={small}>
              {t("leag.report")}
            </button>
          )}
          {m.status === "reported" && m.reportedBy === me && (
            <>
              <span className="text-slate-500">{t("leag.reportedByYou")}</span>
              <button
                onClick={() => {
                  setWon(m.winner === me);
                  setScore(m.score ? (m.a === me ? m.score : flip(m.score)) : "");
                  setMode("report");
                }}
                className="text-teal-700 underline"
              >
                {t("leag.report")}
              </button>
            </>
          )}
          {m.status === "reported" && m.reportedBy !== me && (
            <>
              <span className="text-slate-500">{t("leag.reportedByThem", { name: names.get(them!) ?? "" })}</span>
              <button onClick={() => void post({ action: "confirm", version: m.version })} className={small}>
                {t("leag.confirm")}
              </button>
              <button onClick={() => setMode("dispute")} className="text-red-700 underline">
                {t("leag.dispute")}
              </button>
            </>
          )}
        </div>
      )}
      {mineMatch && mode === "report" && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await post({ action: "report", winner: won ? me : them, score, version: m.version })) setMode("idle");
          }}
          className="mt-2 flex flex-wrap items-center gap-2"
        >
          <select value={won ? "me" : "them"} onChange={(e) => setWon(e.target.value === "me")} className={input}>
            <option value="me">{t("leag.iWon")}</option>
            <option value="them">{t("leag.theyWon")}</option>
          </select>
          <input
            required
            value={score}
            onChange={(e) => setScore(e.target.value)}
            placeholder="21-15, 18-21, 21-10"
            aria-label={t("leag.scoreMine")}
            className={`${input} w-40`}
          />
          <button className={small}>{t("leag.send")}</button>
          <button type="button" onClick={() => setMode("idle")} className="text-xs text-slate-500 underline">
            {t("leag.cancel")}
          </button>
          <span className="w-full text-xs text-slate-500">{t("leag.scoreMine")}</span>
        </form>
      )}
      {mineMatch && mode === "dispute" && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await post({ action: "dispute", note, version: m.version })) setMode("idle");
          }}
          className="mt-2 flex flex-wrap items-center gap-2"
        >
          <input
            required
            minLength={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("leag.disputeNote")}
            className={`${input} flex-1`}
          />
          <button className={small}>{t("leag.send")}</button>
          <button type="button" onClick={() => setMode("idle")} className="text-xs text-slate-500 underline">
            {t("leag.cancel")}
          </button>
        </form>
      )}
    </li>
  );
}
