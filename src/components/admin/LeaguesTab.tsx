"use client";

import { activityKeys } from "@/lib/activity-registry";
import { useCallback, useEffect, useState } from "react";
import { todayLocal } from "./shared";
import type { ManagedVenue } from "./shared";
import { addDays } from "@/lib/time";
import { type Sport } from "@/lib/types";
import type { League, LeagueDetail, LeagueMatch } from "@/lib/leagues";
import type { CompetitionTemplate } from "@/lib/competition-templates";
import { money, currencySymbol } from "@/lib/region";

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
const LEVELS = ["", "beginner", "intermediate", "advanced", "competitive"];

/**
 * A venue's box leagues: set one up; see who has joined and place
 * newcomers; start and end seasons (they also do so by themselves on their
 * dates); settle disputed results, and put any result right.
 */
export function LeaguesTab({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [list, setList] = useState<League[]>([]);
  const [templates, setTemplates] = useState<CompetitionTemplate[]>([]);
  const [open, setOpen] = useState<LeagueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const venue = venues.find((v) => v.id === venueId);

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/leagues?venueId=${venueId}`, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      setList(data.leagues);
      setTemplates(data.templates ?? []);
    }
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function show(id: number, season?: number) {
    const res = await fetch(`/api/admin/leagues/${id}${season ? `?season=${season}` : ""}`, { cache: "no-store" });
    if (res.ok) setOpen((await res.json()).league);
  }

  async function post(url: string, body: object): Promise<boolean> {
    setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "That did not work.");
      return false;
    }
    if (data.league && "boxes" in data.league) setOpen(data.league);
    await load();
    return true;
  }

  if (!venue) return <p className="text-sm text-slate-500">No venue.</p>;
  return (
    <div className="space-y-4">
      {venues.length > 1 && (
        <select
          value={venueId}
          onChange={(e) => {
            setVenueId(Number(e.target.value));
            setOpen(null);
          }}
          className={input}
        >
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      )}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {open ? (
        <Manage l={open} post={post} show={(season) => void show(open.id, season)} close={() => setOpen(null)} />
      ) : (
        <>
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="font-semibold">Leagues</h2>
            {list.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">None yet. Set one up below.</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100 text-sm">
                {list.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{l.name}</span> · {l.players} players ·{" "}
                      <span className="text-slate-500">
                        {l.status === "closed"
                          ? "stopped"
                          : l.current
                            ? `season ${l.current.number} ${l.current.status === "forming" ? `starts ${l.current.startsOn}` : `ends ${l.current.endsOn}`}`
                            : ""}
                      </span>
                    </span>
                    <button onClick={() => void show(l.id)} className="text-sm font-medium text-teal-700 underline">
                      Open
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <Create venue={venue} post={post} templates={templates} />
        </>
      )}
    </div>
  );
}

function Create({ venue, post, templates }: { venue: ManagedVenue; post: (url: string, body: object) => Promise<boolean>; templates: CompetitionTemplate[] }) {
  const sports = activityKeys().filter((s) => venue.courts.some((c) => c.sport === s));
  /** A sport's own template, as a new league starts from (the server picks the same when none is sent). */
  const ownTemplate = (sport: string) => templates.find((x) => x.sports.includes(sport))?.key ?? "";
  const [f, setF] = useState({
    name: "",
    sport: (sports[0] ?? "badminton") as Sport,
    teamSize: 1,
    who: "anyone",
    level: "",
    boxSize: "4",
    moves: "1",
    seasonDays: "28",
    fee: "30",
    startsOn: addDays(todayLocal(), 14),
    description: "",
    // "": the sport's own template.
    template: "",
  });
  const chosen = templates.find((x) => x.key === (f.template || ownTemplate(f.sport)));
  const label = "flex flex-col text-xs font-medium text-slate-500";

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await post("/api/admin/leagues", {
          ...f,
          venueId: venue.id,
          boxSize: Number(f.boxSize),
          moves: Number(f.moves),
          seasonDays: Number(f.seasonDays),
          fee: Number(f.fee),
        });
        if (ok) setF({ ...f, name: "", description: "" });
      }}
      className="space-y-3 rounded-xl border border-dashed border-slate-300 bg-white p-4"
    >
      <h2 className="font-semibold">Set up a box league</h2>
      <p className="text-sm text-slate-500">
        Players join at /leagues. Each season they are put in boxes and play everybody in theirs, booking courts as usual
        and reporting their own scores; the best go up a box and the worst down for the next. Seasons start and end by
        themselves on their dates — you only settle disputes.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className={label}>
          Name
          <input required minLength={3} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={`w-64 ${input}`} placeholder="Evening Singles Ladder" />
        </label>
        <label className={label}>
          Sport
          <select value={f.sport} onChange={(e) => setF({ ...f, sport: e.target.value as Sport })} className={input}>
            {sports.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Play
          <select value={f.teamSize} onChange={(e) => setF({ ...f, teamSize: Number(e.target.value) })} className={input}>
            <option value={1}>Singles</option>
            <option value={2}>Doubles pairs</option>
          </select>
        </label>
        <label className={label}>
          Who can play
          <select value={f.who} onChange={(e) => setF({ ...f, who: e.target.value })} className={input}>
            <option value="anyone">Anyone</option>
            <option value="women">Women only</option>
            <option value="men">Men only</option>
          </select>
        </label>
        <label className={label}>
          Level
          <select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })} className={input}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l || "Open to all"}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Box size
          <input type="number" min={3} max={6} value={f.boxSize} onChange={(e) => setF({ ...f, boxSize: e.target.value })} className={`w-16 ${input}`} />
        </label>
        <label className={label}>
          Up / down
          <select value={f.moves} onChange={(e) => setF({ ...f, moves: e.target.value })} className={input}>
            <option value="1">1 each way</option>
            <option value="2">2 each way</option>
          </select>
        </label>
        <label className={label}>
          Season (days)
          <input type="number" min={14} max={62} value={f.seasonDays} onChange={(e) => setF({ ...f, seasonDays: e.target.value })} className={`w-20 ${input}`} />
        </label>
        <label className={label}>
          Fee a season ({currencySymbol()})
          <input type="number" min={0} step={0.01} value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} className={`w-24 ${input}`} />
        </label>
        {templates.length > 0 && (
          <label className={label}>
            Scored and ranked as
            <select value={f.template || ownTemplate(f.sport)} onChange={(e) => setF({ ...f, template: e.target.value })} className={`w-72 ${input}`}>
              {templates.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={label}>
          First season starts
          <input type="date" required value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} className={input} />
        </label>
      </div>
      {chosen && <p className="text-xs text-slate-500">{chosen.note} A league match always has a winner. Templates are club practice, not a governing body&apos;s regulations.</p>}
      <label className={label}>
        About it (optional)
        <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={2} className={input} />
      </label>
      <button className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">Set it up</button>
    </form>
  );
}

function Manage({
  l,
  post,
  show,
  close,
}: {
  l: LeagueDetail;
  post: (url: string, body: object) => Promise<boolean>;
  show: (season?: number) => void;
  close: () => void;
}) {
  const names = new Map(l.people.map((p) => [p.id, p.name]));
  const base = `/api/admin/leagues/${l.id}`;
  const current = l.current;
  const [startsOn, setStartsOn] = useState(current?.startsOn ?? "");
  const disputed = l.viewing?.status === "running" ? l.matches.filter((m) => m.status === "disputed") : [];
  const waiting = l.viewing?.status === "running" ? l.matches.filter((m) => m.status === "reported").length : 0;
  const lastBox = Math.max(0, ...l.places.map((p) => p.boxNo));
  const editable = l.viewing?.status === "running";

  return (
    <div className="space-y-4">
      <button onClick={close} className="text-sm text-teal-700 underline">
        ← All leagues
      </button>
      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">{l.name}</h2>
            <p className="text-sm text-slate-500">
              {l.sport} · {l.teamSize === 2 ? "doubles pairs" : "singles"}
              {l.who !== "anyone" && ` · ${l.who} only`} · boxes of {l.boxSize} · {l.moves} up and down ·{" "}
              {l.seasonDays}-day seasons · {l.fee > 0 ? `${money(l.fee.toFixed(2))} a season` : "no fee"} · {l.players} players
              {l.status === "closed" && " · stopped"}
            </p>
          </div>
          <a href={`/leagues/${l.id}`} target="_blank" rel="noreferrer" className="text-sm text-teal-700 underline">
            Public page
          </a>
        </div>

        {current?.status === "forming" && (
          <div className="flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3 text-sm">
            <span className="flex-1">
              Season {current.number} starts on <strong>{current.startsOn}</strong> by itself, if 3 or more have joined
              ({l.players} so far).
            </span>
            <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} className={input} />
            <button onClick={() => void post(base, { action: "plan", startsOn })} className="rounded-md border border-slate-300 px-3 py-1.5">
              Move the start
            </button>
            <button
              onClick={() => {
                if (window.confirm("Make the boxes and start the season today?")) void post(base, { action: "start" });
              }}
              className="rounded-md bg-teal-600 px-3 py-1.5 font-semibold text-white hover:bg-teal-700"
            >
              Start it now
            </button>
          </div>
        )}
        {current?.status === "running" && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 p-3 text-sm">
            <span className="flex-1">
              Season {current.number} runs {current.startsOn} to <strong>{current.endsOn}</strong>, and ends by itself
              three days after, for late results.
            </span>
            <button
              onClick={() => {
                const note = [
                  waiting > 0 ? `${waiting} result${waiting === 1 ? "" : "s"} waiting for confirmation will stand.` : "",
                  disputed.length > 0 ? `${disputed.length} disputed result${disputed.length === 1 ? "" : "s"} will not count.` : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                if (window.confirm(`End season ${current.number} now and work out who goes up and down? ${note}`)) void post(base, { action: "end" });
              }}
              className="rounded-md border border-slate-300 px-3 py-1.5"
            >
              End it now
            </button>
          </div>
        )}
        {l.status === "running" && current?.status !== "running" && (
          <button
            onClick={() => {
              if (window.confirm("Stop running this league? Its players are told.")) void post(base, { action: "close" });
            }}
            className="text-sm text-red-700 underline"
          >
            Stop the league
          </button>
        )}
      </section>

      {disputed.length > 0 && (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-sm">
          <h3 className="font-semibold text-amber-900">Disputed results</h3>
          <ul className="mt-2 divide-y divide-amber-200 text-sm">
            {disputed.map((m) => (
              <li key={m.id} className="py-2">
                <div>
                  Box {m.boxNo}: {names.get(m.a)} v {names.get(m.b)} — reported {m.score}, won by {names.get(m.winner ?? 0)}
                  {m.reportedBy && ` (by ${names.get(m.reportedBy)})`}
                </div>
                <div className="text-amber-900">“{m.disputeNote}”</div>
                <Decide m={m} names={names} post={(body) => post(`${base}/matches/${m.id}`, body)} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {l.seasons.filter((s) => s.status !== "forming").length > 1 && (
        <nav className="flex flex-wrap gap-2">
          {l.seasons
            .filter((s) => s.status !== "forming")
            .map((s) => (
              <button
                key={s.id}
                onClick={() => show(s.number)}
                className={`rounded-full px-3 py-1 text-sm ${l.viewing?.id === s.id ? "bg-teal-600 text-white" : "bg-white ring-1 ring-slate-200"}`}
              >
                Season {s.number}
              </button>
            ))}
        </nav>
      )}

      {l.boxes.length > 0 && l.viewing && (
        <section className="space-y-3">
          <h3 className="font-semibold">
            Season {l.viewing.number} <span className="text-sm font-normal text-slate-500">({l.viewing.status})</span>
          </h3>
          <div className="grid gap-3 lg:grid-cols-2">
            {l.boxes.map((box) => (
              <div key={box.boxNo} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <h4 className="font-semibold">Box {box.boxNo}</h4>
                <ul className="mt-1 text-sm">
                  {box.table.map((s, i) => {
                    const place = l.places.find((p) => p.playerId === s.entryId)!;
                    return (
                      <li key={s.entryId} className="flex flex-wrap items-center gap-x-3 py-0.5">
                        <span className={`flex-1 ${place.withdrawn ? "text-slate-400 line-through" : ""}`}>
                          {i + 1}. {names.get(s.entryId)} <span className="text-slate-500">({s.won}–{s.lost})</span>
                          {place.move && place.move !== "stay" && <span className="ml-1 text-xs">{place.move === "up" ? "▲ up" : "▼ down"}</span>}
                        </span>
                        {l.fee > 0 && (
                          <label className="flex items-center gap-1 text-xs text-slate-600">
                            <input
                              type="checkbox"
                              checked={place.paid}
                              onChange={(e) => void post(`${base}/places/${place.id}`, { paid: e.target.checked })}
                            />
                            paid
                          </label>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <ul className="mt-2 divide-y divide-slate-100 text-sm">
                  {l.matches
                    .filter((m) => m.boxNo === box.boxNo)
                    .map((m) => (
                      <li key={m.id} className="py-1.5">
                        <div className="flex flex-wrap gap-x-3">
                          <span className="flex-1">
                            <span className={m.winner === m.a ? "font-semibold" : ""}>{names.get(m.a)}</span> v{" "}
                            <span className={m.winner === m.b ? "font-semibold" : ""}>{names.get(m.b)}</span>
                          </span>
                          <span className="text-slate-600">{m.score}</span>
                          <span className="text-xs text-slate-400">{m.status === "confirmed" ? "" : m.status}</span>
                        </div>
                        {editable && <Decide m={m} names={names} post={(body) => post(`${base}/matches/${m.id}`, body)} compact />}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
          {lastBox > 0 && <p className="text-xs text-slate-500">Scores are written with the first-named player&apos;s games first.</p>}
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="font-semibold">Players</h3>
        <p className="mt-1 text-sm text-slate-500">
          Newcomers go into the bottom box, best level first, unless you give them a box to start in — handy for a strong
          player joining late.
        </p>
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {l.people
            .filter((p) => p.status === "active")
            .map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-1.5">
                <span className="flex-1">
                  {p.name}
                  {p.level && <span className="text-slate-500"> · {p.level}</span>}
                </span>
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  start in box
                  <input
                    type="number"
                    min={1}
                    defaultValue={p.startBox ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value === "" ? null : Number(e.target.value);
                      if (v !== (p.startBox ?? null)) void post(`${base}/players/${p.id}`, { startBox: v });
                    }}
                    className={`w-16 ${input}`}
                  />
                </label>
                <button
                  onClick={() => {
                    if (window.confirm(`Take ${p.name} out of the league? Matches they have not played become walkovers.`))
                      void post(`${base}/players/${p.id}`, { remove: true });
                  }}
                  className="text-xs text-red-700 underline"
                >
                  Remove
                </button>
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

/** Staff putting a result right: a score, a walkover, struck off, or back to be played. */
function Decide({
  m,
  names,
  post,
  compact = false,
}: {
  m: LeagueMatch;
  names: Map<number, string>;
  post: (body: object) => Promise<boolean>;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(!compact);
  const [winner, setWinner] = useState(m.winner ?? m.a);
  const [score, setScore] = useState(m.score ?? "");
  if (!editing)
    return (
      <button onClick={() => setEditing(true)} className="text-xs text-teal-700 underline">
        Change
      </button>
    );
  const small = "rounded-md border border-slate-300 px-2 py-1 text-xs";
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <select value={winner} onChange={(e) => setWinner(Number(e.target.value))} className={small}>
        <option value={m.a}>{names.get(m.a)} won</option>
        <option value={m.b}>{names.get(m.b)} won</option>
      </select>
      <input value={score} onChange={(e) => setScore(e.target.value)} placeholder="21-15, 21-18" className={`w-32 ${small}`} />
      <button onClick={() => void post({ winner, score })} className="rounded-md bg-teal-600 px-2 py-1 text-xs font-semibold text-white">
        Save
      </button>
      <button onClick={() => void post({ winner, walkover: true })} className={small}>
        Walkover
      </button>
      <button onClick={() => void post({ void: true })} className={small}>
        Don&apos;t count
      </button>
      {m.status !== "unplayed" && (
        <button onClick={() => void post({ clear: true })} className={small}>
          To be played
        </button>
      )}
      {compact && (
        <button onClick={() => setEditing(false)} className="text-xs text-slate-500 underline">
          Cancel
        </button>
      )}
    </div>
  );
}
