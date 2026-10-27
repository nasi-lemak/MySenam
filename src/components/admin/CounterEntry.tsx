"use client";

import { useState } from "react";
import { ParticipantPicker, type PickedParticipant } from "./ParticipantPicker";
import { useStaffT } from "./StaffLanguage";

const input = "rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none";

/** Under 18 on the day, by a declared date of birth (the server checks it again). */
function minorOn(birth: string, day: string | null): boolean {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(birth)) return false;
  const [by, bm, bd] = birth.split("-").map(Number);
  const [y, m, d] = day.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0) < 18;
}

/**
 * Staff entering somebody in a tournament, or adding a player to a league,
 * at the counter (lib/competition-entrants.ts): the number and name given, or
 * a participant the venue knows with a guardian on that number, and what the
 * event asks, as the entrant would online. The server applies the same rules.
 */
export function CounterEntry({
  venueId,
  kind,
  teamSize,
  category,
  ageRange = null,
  startsOn = null,
  team = false,
  mark = false,
  submit,
}: {
  venueId: number;
  kind: "tournament" | "league";
  teamSize: 1 | 2;
  /** "open", "women", "men" or "mixed" (a league's who as a category). */
  category: string;
  ageRange?: { min: number | null; max: number | null } | null;
  startsOn?: string | null;
  /** A team event: its name and roster. */
  team?: boolean;
  /** A performance event: an entry mark to seed by. */
  mark?: boolean;
  submit: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const t = useStaffT();
  const empty = { phone: "", name: "", gender: "", partner: "", partnerGender: "", birth: "", partnerBirth: "", guardian: "", guardianOk: false, teamName: "", roster: "", rosterOk: false, entryMark: "" };
  const [f, setF] = useState(empty);
  const [who, setWho] = useState<PickedParticipant | null>(null);
  const [open, setOpen] = useState(false);
  const minors =
    !!ageRange &&
    (minorOn(f.birth, startsOn) || (teamSize === 2 && minorOn(f.partnerBirth, startsOn)) || (team && ageRange.max !== null && ageRange.max < 18));
  const genders = (value: string, set: (v: string) => void, label: string) => (
    <label className="flex flex-col text-xs text-slate-500">
      {label}
      <select required value={value} onChange={(e) => set(e.target.value)} className={input}>
        <option value="">—</option>
        <option value="woman">{t("lg5.woman")}</option>
        <option value="man">{t("lg5.man")}</option>
      </select>
    </label>
  );
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="text-sm text-teal-700 underline">
        {t(kind === "tournament" ? "lg5.counter.tournament" : "lg5.counter.league")}
      </button>
    );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const done = await submit({
          phone: f.phone,
          ...(who ? { participantId: who.id } : { name: f.name }),
          ...(category !== "open" ? { gender: f.gender } : {}),
          ...(teamSize === 2
            ? {
                partnerName: f.partner,
                // A women's or men's doubles takes the event's, as the public form does; a league's pairs, and mixed, are asked.
                partnerGender: kind === "tournament" && category === "women" ? "woman" : kind === "tournament" && category === "men" ? "man" : f.partnerGender || undefined,
              }
            : {}),
          ...(team ? { teamName: f.teamName, roster: f.roster.split("\n").map((n) => n.trim()).filter(Boolean) } : {}),
          ...(mark && f.entryMark.trim() ? { entryMark: f.entryMark.trim() } : {}),
          ...(ageRange ? { birthDate: f.birth, ...(teamSize === 2 ? { partnerBirthDate: f.partnerBirth } : {}), ...(team ? { rosterEligible: f.rosterOk } : {}) } : {}),
          ...(minors ? { guardianName: f.guardian, guardianConsent: f.guardianOk } : {}),
        });
        if (done) {
          setF(empty);
          setWho(null);
          setOpen(false);
        }
      }}
      className="mt-2 space-y-2 rounded-lg bg-slate-50 p-3 text-sm"
    >
      <h4 className="font-medium">{t(kind === "tournament" ? "lg5.counter.tournament" : "lg5.counter.league")}</h4>
      <p className="text-xs text-slate-500">
        {t("lg5.counter.note")} {kind === "league" && t("lg5.counter.leagueNote")}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs text-slate-500">
          {t("lg5.phone")}
          <input required value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} className={input} />
        </label>
        {!who && (
          <label className="flex flex-col text-xs text-slate-500">
            {t("lg5.name")}
            <input required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={input} />
          </label>
        )}
        {category !== "open" && genders(f.gender, (v) => setF({ ...f, gender: v }), t("lg5.gender"))}
        {teamSize === 2 && (
          <label className="flex flex-col text-xs text-slate-500">
            {t("lg5.partner")}
            <input required minLength={2} value={f.partner} onChange={(e) => setF({ ...f, partner: e.target.value })} className={input} />
          </label>
        )}
        {teamSize === 2 && (category === "mixed" || (kind === "league" && category !== "open")) &&
          genders(f.partnerGender, (v) => setF({ ...f, partnerGender: v }), t("lg5.partnerGender"))}
        {team && (
          <>
            <label className="flex flex-col text-xs text-slate-500">
              {t("lg5.teamName")}
              <input required minLength={2} value={f.teamName} onChange={(e) => setF({ ...f, teamName: e.target.value })} className={input} />
            </label>
            <label className="flex flex-col text-xs text-slate-500">
              {t("lg5.roster")}
              <textarea required rows={3} value={f.roster} onChange={(e) => setF({ ...f, roster: e.target.value })} className={input} />
            </label>
          </>
        )}
        {mark && (
          <label className="flex flex-col text-xs text-slate-500">
            {t("lg5.entryMark")}
            <input value={f.entryMark} onChange={(e) => setF({ ...f, entryMark: e.target.value })} className={`w-28 ${input}`} />
          </label>
        )}
        {ageRange && (
          <label className="flex flex-col text-xs text-slate-500">
            {t("lg5.birthDate")}
            <input type="date" required value={f.birth} onChange={(e) => setF({ ...f, birth: e.target.value })} className={input} />
          </label>
        )}
        {ageRange && teamSize === 2 && (
          <label className="flex flex-col text-xs text-slate-500">
            {t("lg5.partnerBirthDate")}
            <input type="date" required value={f.partnerBirth} onChange={(e) => setF({ ...f, partnerBirth: e.target.value })} className={input} />
          </label>
        )}
        {ageRange && team && (
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <input type="checkbox" required checked={f.rosterOk} onChange={(e) => setF({ ...f, rosterOk: e.target.checked })} />
            {t("lg5.rosterEligible")}
          </label>
        )}
        {minors && (
          <>
            <label className="flex flex-col text-xs text-slate-500">
              {t("lg5.guardianName")}
              <input required minLength={2} value={f.guardian} onChange={(e) => setF({ ...f, guardian: e.target.value })} className={input} />
            </label>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              <input type="checkbox" required checked={f.guardianOk} onChange={(e) => setF({ ...f, guardianOk: e.target.checked })} />
              {t("lg5.guardianConsent")}
            </label>
          </>
        )}
        <button className="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700">
          {t(kind === "tournament" ? "lg5.enter" : "lg5.add")}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-slate-500 underline">
          {t("c.cancel")}
        </button>
      </div>
      <ParticipantPicker venueId={venueId} phone={f.phone} guardianName={f.name} value={who} onChange={setWho} />
    </form>
  );
}
