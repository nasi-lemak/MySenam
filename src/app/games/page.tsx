"use client";

import { activityIcon } from "@/lib/activity-registry";
import { WHO, type Who } from "@/lib/who-shared";
import { accountDetour } from "@/lib/phone-detour";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { NearPicker, type NearChoice } from "@/components/NearPicker";
import { sportLabel, translateError } from "@/lib/i18n";
import type { T } from "@/lib/i18n";
import { addDays, formatHour, slotStartsAt, todayISO } from "@/lib/time";
import { type Sport } from "@/lib/types";
import { useOfferedSports } from "@/components/OfferedSports";
import type { GamePlayer, Level, OpenGame } from "@/lib/games";
import { shortDate } from "@/lib/region";
import type { Intensity } from "@/lib/player-profiles";
import { Suggested } from "./Suggested";
import { HostTools, SafetyButtons } from "./HostTools";
import { HostMove, PlayerMove } from "./MoveGame";

const LEVELS: Level[] = ["beginner", "intermediate", "advanced", "competitive"];
const levelLabel = (t: T, level: Level) => t(`games.level.${level}`);

interface MyBooking {
  code: string;
  date: string;
  startHour: number;
  endHour: number;
  status: string;
  totalPrice: number;
  classId: number | null;
  courtName: string;
  venueName: string;
  /** The venue's time zone (from /api/my/bookings). */
  venueTimeZone?: string;
  sport: Sport;
  /** Set on a weekly booking (from /api/my/bookings). */
  seriesCode?: string | null;
  /** The most players a game on it can look for: ten, or more where the venue lets one booking take more. */
  mostSpots?: number;
}

/**
 * Open games: find players' courts with room, ask to join, pay a share; or
 * open one of your own bookings to others and decide who joins.
 */
export default function GamesPage() {
  const t = useT();
  const today = todayISO();
  const dates = Array.from({ length: 15 }, (_, i) => addDays(today, i));

  const [sport, setSport] = useState<Sport | "">("");
  const sports = useOfferedSports();
  const [date, setDate] = useState("");
  const [level, setLevel] = useState<Level | "">("");
  const [who, setWho] = useState<Who>("anyone");
  const [near, setNear] = useState<NearChoice | null>(null);
  const [games, setGames] = useState<OpenGame[] | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [mine, setMine] = useState<{ hosting: OpenGame[]; playing: OpenGame[]; noShows: number; maxNoShows: number } | null>(null);
  const [levels, setLevels] = useState<Partial<Record<Sport, Level>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // A game shared with a link: /games?game=12&link=…, shown on top, private or not.
  const [shared, setShared] = useState<{ game: OpenGame; link: string } | null>(null);
  const [series, setSeries] = useState<{ id: number; title: string | null; games: OpenGame[] }[]>([]);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (sport) params.set("sport", sport);
    if (date) params.set("date", date);
    if (level) params.set("level", level);
    if (who !== "anyone") params.set("who", who);
    if (near) {
      params.set("near", `${near.lat.toFixed(5)},${near.lng.toFixed(5)}`);
      params.set("km", String(near.km));
    }
    const res = await fetch(`/api/games?${params}`, { cache: "no-store" });
    const data = await res.json();
    setGames(data.games ?? []);
    setSignedIn(Boolean(data.signedIn));
    if (data.signedIn) {
      const [m, l] = await Promise.all([fetch("/api/my/games", { cache: "no-store" }), fetch("/api/my/levels", { cache: "no-store" })]);
      if (m.ok) setMine(await m.json());
      if (l.ok) setLevels((await l.json()).levels);
      const s = await fetch("/api/games/series", { cache: "no-store" });
      if (s.ok) setSeries((await s.json()).series);
    }
    const q = new URLSearchParams(window.location.search);
    const sharedId = Number(q.get("game"));
    const link = q.get("link");
    if (sharedId > 0 && link) {
      const one = await fetch(`/api/games/${sharedId}?link=${encodeURIComponent(link)}`, { cache: "no-store" });
      setShared(one.ok ? { game: (await one.json()).game, link } : null);
    }
    setRefreshKey((k) => k + 1);
  }, [sport, date, level, who, near]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(url: string, body: object, done?: string) {
    setError(null);
    setNotice(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok && accountDetour(data)) return;
    if (!res.ok) return setError(translateError(t, data) || data.error);
    if (data.url) {
      window.location.href = data.url;
      return;
    }
    if (done) setNotice(done);
    await load();
  }

  async function saveLevel(s: Sport, l: Level | null) {
    const res = await fetch("/api/my/levels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sport: s, level: l }),
    });
    if (res.ok) setLevels((await res.json()).levels);
  }

  const chip = (on: boolean) =>
    `shrink-0 rounded-full px-3 py-1 text-sm font-medium transition ${
      on ? "bg-teal-600 text-white shadow" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"
    }`;
  const dayLabel = (d: string) => shortDate(d, t.locale, true);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("games.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("games.intro")}</p>
        <p className="mt-1 flex gap-4 text-sm">
          <Link href="/games/groups" className="text-teal-700 underline">
            {t("groups.title")}
          </Link>
          {signedIn && (
            <Link href="/games/preferences" className="text-teal-700 underline">
              {t("games.preferences")}
            </Link>
          )}
        </p>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

      {shared && (
        <section className="rounded-xl border border-teal-300 bg-white p-4 shadow-sm" data-testid="shared-game">
          <h2 className="text-sm font-semibold text-teal-900">{t("games.shared")}</h2>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {activityIcon(shared.game.sport)} {dayLabel(shared.game.date)}, {formatHour(shared.game.startHour, t.locale)}–{formatHour(shared.game.endHour, t.locale)} ·{" "}
              {shared.game.venueName} · {t("games.hostedBy", { name: shared.game.hostName })}
            </span>
            <JoinButton t={t} g={shared.game} signedIn={signedIn} act={act} link={shared.link} />
          </div>
        </section>
      )}

      {signedIn && mine && (mine.hosting.length > 0 || mine.playing.length > 0) && (
        <MyGames t={t} mine={mine} act={act} refresh={load} say={(msg, err) => (err ? setError(err) : setNotice(msg))} />
      )}

      {series.length > 0 && (
        <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 text-sm" data-testid="weekly-games">
          <h2 className="font-semibold">{t("games.weeklyTitle")}</h2>
          {series.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {s.title ?? s.games[0]?.venueName} · {t("games.datesLeft", { n: s.games.filter((g) => g.status === "open" && g.date >= today).length })}
              </span>
              <button
                onClick={() => void act(`/api/games/series/${s.id}`, { action: "end", callOffUpcoming: true }, t("games.cancelledGame"))}
                className="rounded-md border border-slate-300 px-2 py-0.5 text-xs font-medium text-red-700 hover:border-red-400"
              >
                {t("games.endWeekly")}
              </button>
            </div>
          ))}
        </section>
      )}

      {signedIn && (
        <Suggested t={t} refreshKey={refreshKey} join={(g) => <JoinButton t={t} g={g} signedIn={signedIn} act={act} />} />
      )}

      <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setSport("")} className={chip(sport === "")}>
            {t("games.allSports")}
          </button>
          {sports.map((s) => (
            <button key={s} onClick={() => setSport(s)} className={chip(sport === s)}>
              {activityIcon(s)} {sportLabel(t, s)}
            </button>
          ))}
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          <button onClick={() => setDate("")} className={chip(date === "")}>
            {t("games.anyDay")}
          </button>
          {dates.map((d) => (
            <button key={d} onClick={() => setDate(d)} className={chip(date === d)}>
              {d === today ? t("search.today") : dayLabel(d)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setLevel("")} className={chip(level === "")}>
            {t("games.anyLevel")}
          </button>
          {LEVELS.map((l) => (
            <button key={l} onClick={() => setLevel(l)} className={chip(level === l)}>
              {levelLabel(t, l)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {WHO.map((w) => (
            <button key={w} onClick={() => setWho(w)} className={chip(who === w)}>
              {w === "anyone" ? t("who.all") : t(`who.${w}`)}
            </button>
          ))}
        </div>
        <NearPicker value={near} onChange={setNear} />
        {signedIn && sport && (
          <label className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
            {t("games.yourLevel", { sport: sportLabel(t, sport).toLowerCase() })}
            <select
              value={levels[sport] ?? ""}
              onChange={(e) => void saveLevel(sport, (e.target.value || null) as Level | null)}
              className="rounded-md border border-slate-300 px-2 py-1"
            >
              <option value="">{t("games.notSet")}</option>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {levelLabel(t, l)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {games === null ? null : games.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">{t("games.none")}</div>
      ) : (
        <ul className="space-y-3">
          {games.map((g) => (
            <li key={g.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" data-testid={`game-${g.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold">
                    {activityIcon(g.sport)} {dayLabel(g.date)}, {formatHour(g.startHour, t.locale)}–{formatHour(g.endHour, t.locale)}
                  </div>
                  <div className="text-sm text-slate-600">
                    <Link href={`/venue/${g.venueId}`} className="underline">
                      {g.venueName}
                    </Link>{" "}
                    · {g.courtName} · 📍 {g.area}
                    {g.distanceKm !== undefined && ` · ${t("near.away", { km: g.distanceKm })}`}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full bg-teal-50 px-2 py-0.5 font-medium text-teal-700">
                      {g.level ? levelLabel(t, g.level) : t("games.allLevels")}
                    </span>
                    {g.who !== "anyone" && (
                      <span className="rounded-full bg-fuchsia-50 px-2 py-0.5 font-medium text-fuchsia-800">{t(`who.badge.${g.who}`)}</span>
                    )}
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800">
                      {g.spots - g.joined - g.held > 0 ? t.plural("games.spotsLeft", g.spots - g.joined - g.held) : t("games.waitingCount", { n: g.waiting })}
                    </span>
                    {g.intensity !== "any" && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">{t(`games.intensity.${g.intensity}`)}</span>
                    )}
                    {g.adultsOnly && <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">{t("games.adultsOnly")}</span>}
                    <span className="text-slate-500">
                      {t("games.hostedBy", { name: g.hostName })}
                      {g.hostLevel && ` (${levelLabel(t, g.hostLevel)})`}
                    </span>
                  </div>
                  {g.note && <p className="mt-2 text-sm text-slate-700">“{g.note}”</p>}
                </div>
                <div className="text-right">
                  <div className="font-bold">{g.share > 0 ? t("games.share", { amount: g.share.toFixed(2) }) : t("games.free")}</div>
                  <div className="mt-2">
                    <JoinButton t={t} g={g} signedIn={signedIn} act={act} />
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {signedIn && <OpenOne t={t} act={act} hosted={mine?.hosting.map((g) => g.bookingCode) ?? []} />}
    </div>
  );
}

function JoinButton({
  t,
  g,
  signedIn,
  act,
  link,
}: {
  t: T;
  g: OpenGame;
  signedIn: boolean;
  act: (url: string, body: object, done?: string) => Promise<void>;
  link?: string;
}) {
  const button = "rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700";
  if (!signedIn)
    return (
      <Link href={`/login?next=${encodeURIComponent(link ? `/games?game=${g.id}&link=${link}` : "/games")}`} className={button}>
        {t("games.signInToJoin")}
      </Link>
    );
  if (g.yours) return <span className="text-sm text-slate-500">{t("games.yours")}</span>;
  if (g.mine?.status === "requested")
    return (
      <span className="text-sm text-slate-600">
        {t("games.asked", { name: g.hostName })}{" "}
        <button onClick={() => void act(`/api/games/${g.id}`, { action: "leave" })} className="underline">
          {t("games.withdraw")}
        </button>
      </span>
    );
  if (g.mine?.status === "accepted") return <span className="text-sm font-semibold text-emerald-700">{t("games.in")}</span>;
  if (g.mine?.status === "waitlisted")
    return (
      <span className="text-sm text-slate-600">
        {t("games.waitlisted")}{" "}
        <button onClick={() => void act(`/api/games/${g.id}`, { action: "leave" })} className="underline">
          {t("games.withdraw")}
        </button>
      </span>
    );
  if (g.mine?.status === "offered" || g.mine?.status === "invited")
    return (
      <span className="flex flex-wrap items-center justify-end gap-2 text-sm">
        <button onClick={() => void act(`/api/games/${g.id}`, { action: "join" })} className={button}>
          {g.mine.status === "offered" ? t("games.takePlace") : t("games.acceptInvite")}
        </button>
        <button onClick={() => void act(`/api/games/${g.id}`, { action: "leave" })} className="underline">
          {g.mine.status === "offered" ? t("games.letGo") : t("games.declineInvite")}
        </button>
      </span>
    );
  const full = g.joined + g.held >= g.spots;
  return (
    <button onClick={() => void act(`/api/games/${g.id}`, { action: "join", link })} className={button}>
      {full ? t("games.joinWaitlist") : g.autoAccept ? t("games.join") : t("games.ask")}
    </button>
  );
}

/** The player's own games: requests to answer, and shares to pay. */
function MyGames({
  t,
  mine,
  act,
  refresh,
  say,
}: {
  t: T;
  mine: { hosting: OpenGame[]; playing: OpenGame[]; noShows: number; maxNoShows: number };
  act: (url: string, body: object, done?: string) => Promise<void>;
  refresh: () => Promise<void>;
  say: (msg: string | null, error?: string) => void;
}) {
  const when = (g: OpenGame) => `${g.date} ${formatHour(g.startHour, t.locale)}–${formatHour(g.endHour, t.locale)}`;
  // Local time, whatever the phone's own clock is set to.
  const started = (g: OpenGame) => slotStartsAt(g.date, g.startHour, g.timeZone) <= new Date();
  const small = "rounded-md border border-slate-300 px-2 py-0.5 text-xs font-medium hover:border-teal-500";
  return (
    <section className="space-y-3 rounded-xl border border-teal-200 bg-teal-50/50 p-4">
      <h2 className="font-semibold text-teal-900">{t("games.mineTitle")}</h2>
      {mine.noShows > 0 && (
        <p className="text-sm text-amber-800">{t("games.noShowWarning", { n: mine.noShows, max: mine.maxNoShows })}</p>
      )}
      {mine.hosting.map((g) => (
        <div key={g.id} className="rounded-lg bg-white p-3 text-sm shadow-sm" data-testid={`hosted-${g.id}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">
              {t("games.hosting")}: {g.venueName}, {when(g)} · {t("games.joinedOf", { joined: g.joined, spots: g.spots })}
              {g.waiting > 0 && ` · ${t("games.waitingCount", { n: g.waiting })}`}
              {g.visibility === "private" && ` · ${t("games.private")}`}
            </span>
            {g.status === "open" ? (
              <button onClick={() => void act(`/api/games/${g.id}`, { action: "close" })} className={small}>
                {t("games.close")}
              </button>
            ) : (
              <span className="text-xs text-slate-500">{g.status === "cancelled" ? t("games.cancelled") : t("games.closed")}</span>
            )}
          </div>
          {(g.players ?? []).length === 0 && (g.emailInvites ?? []).length === 0 ? (
            <p className="mt-1 text-slate-500">{t("games.nobodyYet")}</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {(g.players ?? [])
                .filter((p: GamePlayer) => ["requested", "accepted", "invited", "waitlisted", "offered"].includes(p.status))
                .map((p: GamePlayer) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2">
                    <span>
                      {p.name}
                      {p.level && ` (${t(`games.level.${p.level}`)})`} ·{" "}
                      {p.status === "requested"
                        ? t("games.wantsToJoin")
                        : p.status === "invited" || p.status === "waitlisted" || p.status === "offered"
                          ? t(`games.status.${p.status}`)
                          : p.paid
                            ? `${t("games.joined")}, ${t("games.paid").toLowerCase()}`
                            : t("games.joined")}
                      {p.noShow && ` · ${t("games.noShow")}`}
                      {p.toConfirm && ` · ${t("move.toConfirm")}`}
                    </span>
                    {(p.status === "requested" || (p.status === "waitlisted" && g.joined + g.held < g.spots)) && (
                      <>
                        <button onClick={() => void act(`/api/games/${g.id}/players/${p.id}`, { action: "accept" })} className={small}>
                          {t("games.accept")}
                        </button>
                        <button onClick={() => void act(`/api/games/${g.id}/players/${p.id}`, { action: "decline" })} className={small}>
                          {t("games.decline")}
                        </button>
                      </>
                    )}
                    {(p.status === "accepted" || p.status === "invited" || p.status === "offered" || p.status === "waitlisted") && !started(g) && (
                      <button onClick={() => void act(`/api/games/${g.id}/players/${p.id}`, { action: "remove" })} className={small}>
                        {t("games.remove")}
                      </button>
                    )}
                    <SafetyButtons t={t} userId={p.userId} gameId={g.id} done={say} />
                    {p.status === "accepted" && started(g) && !p.noShow && (
                      <button onClick={() => void act(`/api/games/${g.id}/players/${p.id}`, { action: "no_show" })} className={small}>
                        {t("games.noShow")}
                      </button>
                    )}
                  </li>
                ))}
              {/* Invited by email: nothing about who until they accept; withdrawn on a confirm, until then. */}
              {(g.emailInvites ?? []).map((x) => (
                <li key={`email-${x.id}`} className="flex flex-wrap items-center gap-2 text-slate-500" data-testid="email-invite">
                  <span>{x.withdrawn ? t("rv7.withdrawnEmail") : t("gi7.invitedEmail")}</span>
                  {!x.withdrawn && (
                    <button
                      onClick={() =>
                        window.confirm(t("rv7.withdrawConfirm")) &&
                        void act(`/api/games/${g.id}`, { action: "withdrawInvitation", invitationId: x.id }, t("rv7.withdrawnOk"))
                      }
                      className={small}
                    >
                      {t("rv7.withdraw")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!started(g) && g.status !== "cancelled" && (
            <HostMove
              t={t}
              g={g}
              act={act}
              done={(message) => {
                say(message);
                void refresh();
              }}
            />
          )}
          {!started(g) && <HostTools t={t} g={g} act={act} />}
        </div>
      ))}
      {mine.playing.map((g) => (
        <div key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white p-3 text-sm shadow-sm" data-testid={`playing-${g.id}`}>
          <span>
            {t("games.playing")}: {g.venueName}, {g.courtName}, {when(g)} · {t("games.hostedBy", { name: g.hostName })} ·{" "}
            {g.mine?.status === "requested"
              ? t("games.asked", { name: g.hostName })
              : g.mine?.status === "waitlisted"
                ? t("games.waitlisted")
                : g.mine?.status === "invited"
                  ? t("games.invitedYou", { name: g.hostName })
                  : g.mine?.status === "offered"
                    ? t("games.offered", { time: (g.mine.expiresAt ?? "").slice(11, 16) })
                    : t("games.in")}{" "}
            <SafetyButtons t={t} userId={g.hostId} gameId={g.id} done={say} />
          </span>
          <span className="flex flex-wrap items-center gap-2">
            {g.mine?.status === "accepted" && g.share > 0 &&
              (g.mine.paid ? (
                <span className="text-xs font-semibold text-emerald-700">{t("games.paid")}</span>
              ) : g.payOnline ? (
                <button
                  onClick={() => void act(`/api/games/${g.id}`, { action: "pay" })}
                  className="rounded-md bg-teal-600 px-2 py-1 text-xs font-semibold text-white hover:bg-teal-700"
                >
                  {t("games.pay", { amount: g.share.toFixed(2) })}
                </button>
              ) : (
                <span className="text-xs text-slate-600">{t("games.payAtVenue", { amount: g.share.toFixed(2) })}</span>
              ))}
            {!started(g) && (g.mine?.status === "invited" || g.mine?.status === "offered") && (
              <button
                onClick={() => void act(`/api/games/${g.id}`, { action: "join" })}
                className="rounded-md bg-teal-600 px-2 py-1 text-xs font-semibold text-white hover:bg-teal-700"
              >
                {g.mine.status === "offered" ? t("games.takePlace") : t("games.acceptInvite")}
              </button>
            )}
            {!started(g) && !g.mine?.toConfirm && (
              <button onClick={() => void act(`/api/games/${g.id}`, { action: "leave" })} className={small}>
                {g.mine?.status === "invited"
                  ? t("games.declineInvite")
                  : g.mine?.status === "offered"
                    ? t("games.letGo")
                    : g.mine?.status === "requested" || g.mine?.status === "waitlisted"
                      ? t("games.withdraw")
                      : t("games.leave")}
              </button>
            )}
          </span>
          {!started(g) && <PlayerMove t={t} g={g} act={act} />}
        </div>
      ))}
    </section>
  );
}

/** Open one of your own upcoming bookings to other players. */
function OpenOne({
  t,
  act,
  hosted,
}: {
  t: T;
  act: (url: string, body: object, done?: string) => Promise<void>;
  hosted: string[];
}) {
  const [bookings, setBookings] = useState<MyBooking[]>([]);
  const [code, setCode] = useState("");
  const [spots, setSpots] = useState(1);
  const [level, setLevel] = useState<Level | "">("");
  const [share, setShare] = useState("");
  const [autoAccept, setAutoAccept] = useState(false);
  const [note, setNote] = useState("");
  const [whoCan, setWhoCan] = useState<Who>("anyone");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [waitlist, setWaitlist] = useState(true);
  const [intensity, setIntensity] = useState<Intensity>("any");
  const [adultsOnly, setAdultsOnly] = useState(false);
  const [weekly, setWeekly] = useState(false);

  useEffect(() => {
    fetch("/api/my/bookings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { bookings: [] }))
      .then((d) => setBookings(d.bookings ?? []));
  }, []);

  const now = new Date();
  const upcoming = bookings.filter(
    (b) =>
      b.status === "confirmed" &&
      b.classId === null &&
      !hosted.includes(b.code) &&
      slotStartsAt(b.date, b.startHour, b.venueTimeZone) > now
  );
  const chosen = upcoming.find((b) => b.code === code) ?? upcoming[0];
  // Split the court evenly among everybody playing, to the 50 sen.
  const suggested = chosen ? Math.ceil((chosen.totalPrice / (spots + 1)) * 2) / 2 : 0;
  const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <section className="rounded-xl border border-dashed border-slate-300 bg-white p-4">
      <h2 className="font-semibold">{t("games.openTitle")}</h2>
      {upcoming.length === 0 ? (
        <p className="mt-1 text-sm text-slate-500">{t("games.noBookings")}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              weekly && chosen?.seriesCode ? "/api/games/series" : "/api/games",
              {
                bookingCode: chosen!.code,
                spots,
                level: level || null,
                share: share === "" ? suggested : Number(share),
                autoAccept,
                note,
                who: whoCan,
                visibility,
                waitlist,
                intensity,
                adultsOnly,
              },
              weekly && chosen?.seriesCode ? t("games.weeklyStarted") : t("games.opened")
            );
          }}
          className="mt-3 flex flex-wrap items-end gap-3 text-sm"
        >
          <label className="flex flex-col text-xs text-slate-500">
            {t("games.booking")}
            <select value={chosen?.code} onChange={(e) => setCode(e.target.value)} className={input}>
              {upcoming.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.venueName}, {b.courtName}, {b.date} {formatHour(b.startHour, t.locale)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            {t("games.spots")}
            <input type="number" min={1} max={chosen?.mostSpots ?? 10} value={spots} onChange={(e) => setSpots(Number(e.target.value))} className={`w-20 ${input}`} />
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            {t("games.levelWanted")}
            <select value={level} onChange={(e) => setLevel(e.target.value as Level | "")} className={input}>
              <option value="">{t("games.allLevels")}</option>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {levelLabel(t, l)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            {t("games.whoCanJoin")}
            <select value={whoCan} onChange={(e) => setWhoCan(e.target.value as Who)} className={input}>
              {WHO.map((w) => (
                <option key={w} value={w}>
                  {t(`who.${w}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            {t("games.shareEach")}
            <input
              type="number"
              min={0}
              step={0.5}
              placeholder={String(suggested)}
              value={share}
              onChange={(e) => setShare(e.target.value)}
              className={`w-24 ${input}`}
            />
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            {t("games.intensity")}
            <select value={intensity} onChange={(e) => setIntensity(e.target.value as Intensity)} className={input} name="intensity">
              {(["any", "casual", "competitive"] as const).map((i) => (
                <option key={i} value={i}>
                  {t(`games.intensity.${i}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            {t("games.visibility")}
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as "public" | "private")} className={input} name="visibility">
              <option value="public">{t("games.visibility.public")}</option>
              <option value="private">{t("games.visibility.private")}</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 pb-2 text-slate-600">
            <input type="checkbox" checked={autoAccept} onChange={(e) => setAutoAccept(e.target.checked)} />
            {t("games.autoAccept")}
          </label>
          <label className="flex items-center gap-1.5 pb-2 text-slate-600">
            <input type="checkbox" checked={waitlist} onChange={(e) => setWaitlist(e.target.checked)} name="waitlist" />
            {t("games.keepWaitlist")}
          </label>
          <label className="flex items-center gap-1.5 pb-2 text-slate-600">
            <input type="checkbox" checked={adultsOnly} onChange={(e) => setAdultsOnly(e.target.checked)} name="adultsOnly" />
            {t("games.adultsOnlyOption")}
          </label>
          {chosen?.seriesCode && (
            <label className="flex items-center gap-1.5 pb-2 text-slate-600">
              <input type="checkbox" checked={weekly} onChange={(e) => setWeekly(e.target.checked)} name="weekly" />
              {t("games.weekly")}
            </label>
          )}
          <input
            placeholder={t("games.note")}
            value={note}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
            className={`min-w-0 flex-1 ${input}`}
          />
          <button className="rounded-lg bg-teal-600 px-4 py-2 font-semibold text-white hover:bg-teal-700">{t("games.openIt")}</button>
        </form>
      )}
    </section>
  );
}
