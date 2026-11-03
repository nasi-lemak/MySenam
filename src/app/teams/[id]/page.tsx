"use client";

import { readJson } from "@/lib/read-response";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { ActivityGlyph } from "@/components/Glyph";
import { sportLabel, translateError } from "@/lib/i18n";
import type { Team, TeamHistory } from "@/lib/teams";

type Person = { id: number; displayName: string };

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
const small = "rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-teal-500";
const primary = "rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700";

/**
 * One team: for its members the roster (a child named only to the captain and their guardian), what each declared for
 * events' age ranges and categories, and the captain's tools (invitations by email or a link, a child they manage,
 * handing over, archiving); for anybody else its name and sport, if published (lib/teams.ts).
 */
export default function TeamPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const [team, setTeam] = useState<Team | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [history, setHistory] = useState<TeamHistory | null>(null);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [child, setChild] = useState({ participantId: "", birthDate: "", gender: "" });
  const [edit, setEdit] = useState({ name: "", description: "" });

  const load = useCallback(async () => {
    const res = await fetch(`/api/teams/${id}`, { cache: "no-store" });
    if (!res.ok) return setMissing(true);
    const data = await readJson(res);
    setTeam(data.team);
    setSignedIn(Boolean(data.signedIn));
    setEdit({ name: data.team.name, description: data.team.description ?? "" });
    if (data.team.roster) {
      const h = await fetch(`/api/teams/${id}/history`, { cache: "no-store" });
      if (h.ok) setHistory((await readJson(h)).history);
      const p = await fetch("/api/my/people", { cache: "no-store" });
      if (p.ok) setPeople(((await readJson(p)).people ?? []).map((x: { id: number; displayName: string }) => ({ id: x.id, displayName: x.displayName })));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function call(method: "POST" | "PATCH", body: object): Promise<Record<string, unknown> | null> {
    setError(null);
    const res = await fetch(`/api/teams/${id}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await readJson(res);
    if (!res.ok) {
      setError(translateError(t, out) || out.error);
      return null;
    }
    if (out.team) setTeam(out.team);
    return out;
  }

  if (missing) return <p className="text-slate-500">{t("tm.ui.notFound")}</p>;
  if (!team) return null;
  const member = team.roster !== undefined;
  const captain = team.isCaptain === true;
  const mineIds = new Set((team.mine ?? []).map((m) => m.memberId));

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Link href="/teams" className="text-sm text-teal-700 underline">
          ← {t("tm.ui.title")}
        </Link>
        <h1 className="mt-1 text-2xl font-bold">
          <ActivityGlyph sport={team.sport} /> {team.name}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {sportLabel(t, team.sport)}
          {team.venueName && ` · ${team.venueName}`}
          {team.groupName && ` · ${team.groupName}`}
          {member && ` · ${t("tm.ui.members", { n: team.members })}`}
          {member && team.captainName && ` · ${t("tm.ui.captainIs", { name: team.captainName })}`}
        </p>
        {team.description && <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{team.description}</p>}
        {!member && <p className="mt-2 text-sm text-slate-500">{t("tm.ui.publicNote")}</p>}
        {member && !team.published && <p className="mt-2 text-xs text-slate-500">{t("tm.ui.notPublished")}</p>}
        {team.status === "archived" && <p className="mt-2 text-sm text-amber-800">{t("tm.ui.archivedNote")}</p>}
      </div>
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {!signedIn && !member && (
        <p className="text-sm text-slate-600">
          <Link href={`/login?next=/teams/${id}`} className="text-teal-700 underline">
            {t("tm.ui.signIn")}
          </Link>
        </p>
      )}

      {member && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">{t("tm.ui.roster")}</h2>
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {team.roster!.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {m.name ?? t("tm.ui.junior")}
                  {m.role === "captain" && <span className="ml-2 rounded bg-teal-50 px-1.5 py-0.5 text-xs text-teal-800">{t("tm.ui.captain")}</span>}
                  {m.mine && <span className="ml-2 text-xs text-slate-500">{m.participantId ? t("tm.ui.forChild") : t("tm.ui.you")}</span>}
                </span>
                <span className="space-x-1">
                  {captain && m.role !== "captain" && team.status === "active" && (
                    <>
                      {!m.junior && (
                        <button className={small} onClick={() => void call("POST", { action: "transfer", memberId: m.id })}>
                          {t("tm.ui.makeCaptain")}
                        </button>
                      )}
                      <button className={small} onClick={() => void call("POST", { action: "remove", memberId: m.id })}>
                        {t("tm.ui.remove")}
                      </button>
                    </>
                  )}
                  {m.mine && m.role !== "captain" && (
                    <button className={small} onClick={() => void call("POST", { action: "leave", ...(m.participantId ? { participantId: m.participantId } : {}) }).then(() => load())}>
                      {t("tm.ui.leave")}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {member &&
        team.roster!
          .filter((m) => mineIds.has(m.id))
          .map((m) => (
            <MemberDetails key={m.id} t={t} m={m} onSave={(birthDate, gender) => call("POST", { action: "details", memberId: m.id, birthDate: birthDate || undefined, gender: gender || undefined })} />
          ))}

      {captain && team.status === "active" && (
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">{t("tm.ui.invite")}</h2>
          <p className="text-sm text-slate-600">{t("tm.ui.inviteIntro")}</p>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void call("POST", { action: "inviteEmail", email }).then((out) => {
                if (out) {
                  setSent(true);
                  setEmail("");
                }
              });
            }}
          >
            <label className="flex flex-col text-xs text-slate-500">
              {t("tm.ui.inviteEmail")}
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={`w-64 ${input}`} name="inviteEmail" />
            </label>
            <button className={primary}>{t("tm.ui.sendInvite")}</button>
          </form>
          {sent && (
            <p role="status" className="text-sm text-teal-800">
              {t("tm.ui.invited", { days: 14 })}
            </p>
          )}
          <div className="space-y-2">
            <button
              className={small}
              onClick={() =>
                void call("POST", { action: "inviteLink" }).then((out) => {
                  if (out) {
                    setLink(String(out.link));
                    setCopied(false);
                  }
                })
              }
            >
              {t("tm.ui.makeLink")}
            </button>
            {link && (
              <div className="space-y-1 text-sm">
                <p className="text-xs text-slate-500">{t("tm.ui.linkShown")}</p>
                <input readOnly value={link} aria-label={t("tm.ui.linkShown")} className={`w-full ${input}`} onFocus={(e) => e.currentTarget.select()} />
                <div className="space-x-2">
                  <button
                    className={small}
                    onClick={() => {
                      void navigator.clipboard?.writeText(link);
                      setCopied(true);
                    }}
                  >
                    {copied ? t("tm.ui.copied") : t("tm.ui.copy")}
                  </button>
                  <a className={small} href={`https://wa.me/?text=${encodeURIComponent(t("tm.ui.linkText", { team: team.name, link }))}`} target="_blank" rel="noreferrer">
                    {t("tm.ui.whatsapp")}
                  </a>
                </div>
              </div>
            )}
          </div>
          {(team.invitations ?? []).length > 0 && (
            <div>
              <h3 className="text-sm font-medium">{t("tm.ui.openInvites")}</h3>
              <ul className="mt-1 space-y-1 text-sm text-slate-600">
                {team.invitations!.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-2">
                    <span>
                      {i.kind === "email" ? t("tm.ui.byEmail") : t("tm.ui.byLink")} · {t("tm.ui.runsOut", { date: i.expiresAt.slice(0, 10) })}
                    </span>
                    <button className={small} onClick={() => void call("POST", { action: "withdrawInvitation", invitationId: i.id })}>
                      {t("tm.ui.withdraw")}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {people.length > 0 && (
            <form
              className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                void call("POST", { action: "addChild", participantId: Number(child.participantId), birthDate: child.birthDate || undefined, gender: child.gender || undefined }).then((out) => {
                  if (out) setChild({ participantId: "", birthDate: "", gender: "" });
                });
              }}
            >
              <h3 className="w-full text-sm font-medium">{t("tm.ui.addChild")}</h3>
              <p className="w-full text-xs text-slate-500">{t("tm.ui.addChildNote")}</p>
              <label className="flex flex-col text-xs text-slate-500">
                {t("tm.ui.choosePerson")}
                <select required value={child.participantId} onChange={(e) => setChild({ ...child, participantId: e.target.value })} className={input} name="childPerson">
                  <option value="" />
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col text-xs text-slate-500">
                {t("tm.ui.dob")}
                <input type="date" value={child.birthDate} onChange={(e) => setChild({ ...child, birthDate: e.target.value })} className={input} name="childBirth" />
              </label>
              <label className="flex flex-col text-xs text-slate-500">
                {t("tm.ui.gender")}
                <select value={child.gender} onChange={(e) => setChild({ ...child, gender: e.target.value })} className={input} name="childGender">
                  <option value="">{t("tm.ui.genderNone")}</option>
                  <option value="woman">{t("tm.ui.woman")}</option>
                  <option value="man">{t("tm.ui.man")}</option>
                </select>
              </label>
              <button className={primary}>{t("tm.ui.addChildButton")}</button>
            </form>
          )}
        </section>
      )}

      {captain && team.status === "active" && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">{t("tm.ui.settings")}</h2>
          <form
            className="mt-2 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void call("PATCH", { name: edit.name, description: edit.description });
            }}
          >
            <label className="flex flex-col text-xs text-slate-500">
              {t("tm.ui.name")}
              <input required minLength={3} maxLength={60} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} className={input} name="editName" />
            </label>
            <input aria-label={t("tm.ui.description")} placeholder={t("tm.ui.description")} maxLength={500} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} className={`min-w-0 flex-1 ${input}`} />
            <button className={small}>{t("tm.ui.save")}</button>
          </form>
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={team.published} onChange={(e) => void call("PATCH", { published: e.target.checked })} />
            {t("tm.ui.publish")}
          </label>
          <p className="mt-1 text-xs text-slate-500">{t("tm.ui.publishNote")}</p>
          <button className={`${small} mt-3`} onClick={() => void call("POST", { action: "archive" })}>
            {t("tm.ui.archive")}
          </button>
        </section>
      )}
      {captain && team.status === "archived" && (
        <button className={small} onClick={() => void call("POST", { action: "restore" })}>
          {t("tm.ui.restore")}
        </button>
      )}

      {member && history && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">{t("tm.ui.history")}</h2>
          {history.tournaments.length === 0 && history.leagues.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">{t("tm.ui.historyNone")}</p>
          ) : (
            <ul className="mt-2 space-y-3 text-sm">
              {history.tournaments.map((h) => (
                <li key={`t${h.entryId}`}>
                  <Link href={`/tournaments/${h.tournamentId}`} className="font-medium underline">
                    {h.tournament}
                  </Link>{" "}
                  <span className="text-slate-500">
                    {h.venue} · {h.startsOn}
                  </span>
                  <ul className="mt-1 text-slate-600">
                    {h.results.map((r, i) => (
                      <li key={i}>
                        {r.won === null ? "–" : r.won ? t("tm.ui.won") : t("tm.ui.lost")} {t("tm.ui.against", { team: r.opponent })} {r.score ?? ""}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
              {history.leagues.map((h) => (
                <li key={`l${h.leagueId}`}>
                  <Link href={`/team-leagues/${h.leagueId}`} className="font-medium underline">
                    {h.league}
                  </Link>{" "}
                  <span className="text-slate-500">{h.venue}</span>
                  <ul className="mt-1 text-slate-600">
                    {h.fixtures.map((f) => (
                      <li key={f.fixtureId}>
                        {f.date} · {f.home ? t("tml.home") : t("tml.away")} {t("tm.ui.against", { team: f.opponent })}
                        {f.score ? ` · ${f.won === null ? t("tm.ui.drew") : f.won ? t("tm.ui.won") : t("tm.ui.lost")} ${f.score}` : ""}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-sm text-slate-600">
            <Link href="/team-leagues" className="text-teal-700 underline">
              {t("tml.title")}
            </Link>{" "}
            ·{" "}
            <Link href="/tournaments" className="text-teal-700 underline">
              {t("nav.tournaments")}
            </Link>
          </p>
        </section>
      )}
    </div>
  );
}

/** What a member (or a guardian for a child) says about themself, so an event's age range and category can be checked: their word. */
function MemberDetails({
  t,
  m,
  onSave,
}: {
  t: ReturnType<typeof useT>;
  m: NonNullable<Team["roster"]>[number];
  onSave: (birthDate: string, gender: string) => Promise<unknown>;
}) {
  const [birthDate, setBirthDate] = useState("");
  const [gender, setGender] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(birthDate, gender).then((out) => setSaved(Boolean(out)));
      }}
    >
      <h2 className="w-full font-semibold">
        {t("tm.ui.details")}
        {m.name ? ` — ${m.name}` : ""}
      </h2>
      <p className="w-full text-xs text-slate-500">
        {t("tm.ui.dobNote")} {m.birthDeclared ? t("tm.ui.dobSaid") : ""}
      </p>
      <label className="flex flex-col text-xs text-slate-500">
        {t("tm.ui.dob")}
        <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} className={input} name={`dob${m.id}`} />
      </label>
      <label className="flex flex-col text-xs text-slate-500">
        {t("tm.ui.gender")}
        <select value={gender} onChange={(e) => setGender(e.target.value)} className={input} name={`gender${m.id}`}>
          <option value="">{t("tm.ui.genderNone")}</option>
          <option value="woman">{t("tm.ui.woman")}</option>
          <option value="man">{t("tm.ui.man")}</option>
        </select>
      </label>
      <button className={small}>{t("tm.ui.saveDetails")}</button>
      {saved && (
        <span role="status" className="text-teal-800">
          {t("tm.ui.saved")}
        </span>
      )}
    </form>
  );
}
