"use client";

import { phoneDetour } from "@/lib/phone-detour";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { NearPicker, type NearChoice } from "@/components/NearPicker";
import { sportLabel, translateError } from "@/lib/i18n";
import type { T } from "@/lib/i18n";
import { addDays, formatHour, todayISO } from "@/lib/time";
import { SPORT_ICONS, SPORTS, type Sport } from "@/lib/types";
import type { GamePlayer, Level, OpenGame } from "@/lib/games";

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
  sport: Sport;
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
  const [date, setDate] = useState("");
  const [level, setLevel] = useState<Level | "">("");
  const [near, setNear] = useState<NearChoice | null>(null);
  const [games, setGames] = useState<OpenGame[] | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [mine, setMine] = useState<{ hosting: OpenGame[]; playing: OpenGame[]; noShows: number; maxNoShows: number } | null>(null);
  const [levels, setLevels] = useState<Partial<Record<Sport, Level>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (sport) params.set("sport", sport);
    if (date) params.set("date", date);
    if (level) params.set("level", level);
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
    }
  }, [sport, date, level, near]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(url: string, body: object, done?: string) {
    setError(null);
    setNotice(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok && phoneDetour(data)) return;
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
  const dayLabel = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(t.locale === "ms" ? "ms-MY" : "en-MY", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("games.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("games.intro")}</p>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

      {signedIn && mine && (mine.hosting.length > 0 || mine.playing.length > 0) && (
        <MyGames t={t} mine={mine} act={act} />
      )}

      <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setSport("")} className={chip(sport === "")}>
            {t("games.allSports")}
          </button>
          {SPORTS.map((s) => (
            <button key={s} onClick={() => setSport(s)} className={chip(sport === s)}>
              {SPORT_ICONS[s]} {sportLabel(t, s)}
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
            <li key={g.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold">
                    {SPORT_ICONS[g.sport]} {dayLabel(g.date)}, {formatHour(g.startHour)}–{formatHour(g.endHour)}
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
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800">
                      {t.plural("games.spotsLeft", g.spots - g.joined)}
                    </span>
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
}: {
  t: T;
  g: OpenGame;
  signedIn: boolean;
  act: (url: string, body: object, done?: string) => Promise<void>;
}) {
  const button = "rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700";
  if (!signedIn)
    return (
      <Link href="/login?next=/games" className={button}>
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
  return (
    <button onClick={() => void act(`/api/games/${g.id}`, { action: "join" })} className={button}>
      {g.autoAccept ? t("games.join") : t("games.ask")}
    </button>
  );
}

/** The player's own games: requests to answer, and shares to pay. */
function MyGames({
  t,
  mine,
  act,
}: {
  t: T;
  mine: { hosting: OpenGame[]; playing: OpenGame[]; noShows: number; maxNoShows: number };
  act: (url: string, body: object, done?: string) => Promise<void>;
}) {
  const when = (g: OpenGame) => `${g.date} ${formatHour(g.startHour)}–${formatHour(g.endHour)}`;
  // Malaysia time, whatever the phone's own clock is set to.
  const started = (g: OpenGame) => new Date(`${g.date}T${String(g.startHour).padStart(2, "0")}:00:00+08:00`) <= new Date();
  const small = "rounded-md border border-slate-300 px-2 py-0.5 text-xs font-medium hover:border-teal-500";
  return (
    <section className="space-y-3 rounded-xl border border-teal-200 bg-teal-50/50 p-4">
      <h2 className="font-semibold text-teal-900">{t("games.mineTitle")}</h2>
      {mine.noShows > 0 && (
        <p className="text-sm text-amber-800">{t("games.noShowWarning", { n: mine.noShows, max: mine.maxNoShows })}</p>
      )}
      {mine.hosting.map((g) => (
        <div key={g.id} className="rounded-lg bg-white p-3 text-sm shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">
              {t("games.hosting")}: {g.venueName}, {when(g)} · {t("games.joinedOf", { joined: g.joined, spots: g.spots })}
            </span>
            {g.status === "open" ? (
              <button onClick={() => void act(`/api/games/${g.id}`, { action: "close" })} className={small}>
                {t("games.close")}
              </button>
            ) : (
              <span className="text-xs text-slate-500">{g.status === "cancelled" ? t("games.cancelled") : t("games.closed")}</span>
            )}
          </div>
          {(g.players ?? []).length === 0 ? (
            <p className="mt-1 text-slate-500">{t("games.nobodyYet")}</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {(g.players ?? [])
                .filter((p: GamePlayer) => p.status === "requested" || p.status === "accepted")
                .map((p: GamePlayer) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2">
                    <span>
                      {p.name}
                      {p.level && ` (${t(`games.level.${p.level}`)})`} ·{" "}
                      {p.status === "requested" ? t("games.wantsToJoin") : p.paid ? `${t("games.joined")}, ${t("games.paid").toLowerCase()}` : t("games.joined")}
                      {p.noShow && ` · ${t("games.noShow")}`}
                    </span>
                    {p.status === "requested" && (
                      <>
                        <button onClick={() => void act(`/api/games/${g.id}/players/${p.id}`, { action: "accept" })} className={small}>
                          {t("games.accept")}
                        </button>
                        <button onClick={() => void act(`/api/games/${g.id}/players/${p.id}`, { action: "decline" })} className={small}>
                          {t("games.decline")}
                        </button>
                      </>
                    )}
                    {p.status === "accepted" && !started(g) && (
                      <button onClick={() => void act(`/api/games/${g.id}/players/${p.id}`, { action: "remove" })} className={small}>
                        {t("games.remove")}
                      </button>
                    )}
                    {p.status === "accepted" && started(g) && !p.noShow && (
                      <button onClick={() => void act(`/api/games/${g.id}/players/${p.id}`, { action: "no_show" })} className={small}>
                        {t("games.noShow")}
                      </button>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </div>
      ))}
      {mine.playing.map((g) => (
        <div key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white p-3 text-sm shadow-sm">
          <span>
            {t("games.playing")}: {g.venueName}, {g.courtName}, {when(g)} · {t("games.hostedBy", { name: g.hostName })} ·{" "}
            {g.mine?.status === "requested" ? t("games.asked", { name: g.hostName }) : t("games.in")}
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
            {!started(g) && (
              <button onClick={() => void act(`/api/games/${g.id}`, { action: "leave" })} className={small}>
                {g.mine?.status === "requested" ? t("games.withdraw") : t("games.leave")}
              </button>
            )}
          </span>
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
      new Date(`${b.date}T${String(b.startHour).padStart(2, "0")}:00:00+08:00`) > now
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
              "/api/games",
              {
                bookingCode: chosen!.code,
                spots,
                level: level || null,
                share: share === "" ? suggested : Number(share),
                autoAccept,
                note,
              },
              t("games.opened")
            );
          }}
          className="mt-3 flex flex-wrap items-end gap-3 text-sm"
        >
          <label className="flex flex-col text-xs text-slate-500">
            {t("games.booking")}
            <select value={chosen?.code} onChange={(e) => setCode(e.target.value)} className={input}>
              {upcoming.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.venueName}, {b.courtName}, {b.date} {formatHour(b.startHour)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            {t("games.spots")}
            <input type="number" min={1} max={10} value={spots} onChange={(e) => setSpots(Number(e.target.value))} className={`w-20 ${input}`} />
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
          <label className="flex items-center gap-1.5 pb-2 text-slate-600">
            <input type="checkbox" checked={autoAccept} onChange={(e) => setAutoAccept(e.target.checked)} />
            {t("games.autoAccept")}
          </label>
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
