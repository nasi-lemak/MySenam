"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdvisorySession, Qualification, RoleChangePreview, RosterException, RosterFlag, RosterPerson, RosterRole, Shift, SupervisionRule, UncoveredSession } from "@/lib/rosters";
import { QUALIFICATION_LEVELS, type QualificationLevel } from "@/lib/restriction-strength";
import { sportLabel } from "@/lib/i18n";
import { clockOf, formatMinute, parseClock } from "@/lib/interval";
import { todayLocal, type ManagedVenue } from "./shared";
import { ManagerOnly } from "./StaffMay";
import { useStaffT } from "./StaffLanguage";
import type { StaffPhrase, StaffT } from "@/lib/staff-i18n";

interface Overview {
  roles: RosterRole[];
  people: RosterPerson[];
  qualifications: Qualification[];
  shifts: Shift[];
  exceptions: RosterException[];
  rules: SupervisionRule[];
  flags: RosterFlag[];
  /** Supervised, but by somebody a recommended qualification is not recorded for (ADR 0046): advisory. */
  advisory?: AdvisorySession[];
}

const field = "rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none";
const button = "rounded-md border border-teal-600 px-2.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50 disabled:opacity-50";
/** Monday first, as a week is read. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** A role's name in the staff language: the starters have words in the dictionary, a role of the venue's own is as it named it. */
export function roleName(t: StaffT, role: { key: string; name: string }): string {
  return t.known(`rs1.role.${role.key}`) ?? role.name;
}

const dayName = (t: StaffT, weekday: number) => t(`coach.day.${weekday}` as StaffPhrase);

/** Who is named on a session, as staff read it: the role and the person, a person named to cover, or the manager's reason to let it stand without. */
export function supervisorsText(
  t: StaffT,
  list: { role: string; roleKey: string; person: string | null; how: "rostered" | "covered" | "override"; reason?: string; qualification?: { why: "not_recorded" | "expired"; qualification: string } }[]
): string {
  const lines = list.map((s) => {
    const role = t.known(`rs1.role.${s.roleKey}`) ?? s.role;
    const line = s.how === "override" ? t("rs1.supStand", { role, reason: s.reason ?? "" }) : s.how === "covered" ? t("rs1.supCovered", { role, person: s.person ?? "" }) : t("rs1.supLine", { role, person: s.person ?? "" });
    // Counted all the same, where the qualification is only recommended (ADR 0046): said, never blocking.
    return s.qualification ? `${line} (${t(`rs1.sup.${s.qualification.why}` as StaffPhrase)})` : line;
  });
  return t("rs1.supBy", { list: lines.join("; ") });
}

/** A time field the way a shift is written: a shift that ends at or before it starts runs into the next day. */
function TimeField({ label, value, onChange }: { label: string; value: number; onChange: (minute: number) => void }) {
  return (
    <input
      type="time"
      step={60}
      aria-label={label}
      value={clockOf(value % 1440)}
      onChange={(e) => {
        const m = parseClock(e.target.value);
        if (m !== null) onChange(m);
      }}
      className={field}
    />
  );
}

/**
 * Who supervises sessions at a venue (lib/rosters.ts; ADR 0036): the roles it rosters, the rules that ask for somebody on
 * shift, the weekly roster with its extra shifts and leave, the qualifications people hold, and the sessions left without their
 * supervisors. A manager edits; front desk sees all of it and changes none of it.
 */
export function RosterPanel({ venue }: { venue: ManagedVenue }) {
  const t = useStaffT();
  const clock = (minute: number) => formatMinute(minute, t.locale);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/roster?venueId=${venue.id}`, { cache: "no-store" });
    if (res.ok) setData(await readJson(res));
  }, [venue.id]);
  useEffect(() => {
    void load();
  }, [load]);

  /** One change to the roster; says which sessions it left uncovered, and reloads. */
  async function change(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId: venue.id, ...body }),
      });
      const out = await readJson(res);
      if (!res.ok) {
        setError(t.err(out, t("rs1.saveFailed")));
        return false;
      }
      const left = (out.affected ?? []).length;
      if (left > 0) setNotice(t.plural("rs1.leftUncovered", left));
      await load();
      window.dispatchEvent(new Event("attention:refresh"));
      window.dispatchEvent(new Event("roster:changed"));
      return true;
    } finally {
      setBusy(false);
    }
  }

  const people = useMemo(() => data?.people ?? [], [data]);
  const roles = (data?.roles ?? []).filter((r) => r.active);
  const personName = useMemo(() => new Map(people.map((p) => [`${p.kind}:${p.id}`, p.name])), [people]);
  const nameOf = (kind: string, id: number) => personName.get(`${kind}:${id}`) ?? t("rs1.formerPerson");
  const roleOf = (id: number | null) => {
    const r = data?.roles.find((x) => x.id === id);
    return r ? roleName(t, r) : "";
  };
  const times = (from: number, to: number) => `${clock(from)}–${clock(to)}${to > 1440 ? ` ${t("rs1.nextDay")}` : ""}`;
  const sports = useMemo(() => [...new Set(venue.courts.map((c) => c.sport))], [venue.courts]);

  // The forms' drafts.
  const [roleDraft, setRoleDraft] = useState({ name: "", qualification: "" });
  const [ruleDraft, setRuleDraft] = useState({ courtId: "", activity: "", roleId: "", needed: "1" });
  const [shiftDraft, setShiftDraft] = useState({ person: "", roleId: "", weekday: "1", from: 9 * 60, to: 17 * 60 });
  const [exDraft, setExDraft] = useState({ person: "", kind: "leave", date: todayLocal(), roleId: "", whole: true, from: 9 * 60, to: 17 * 60, note: "" });
  const [qualDraft, setQualDraft] = useState({ person: "", qualification: "", reference: "", expiresOn: "" });

  const splitPerson = (v: string): { personKind: string; personId: number } | null => {
    const [kind, id] = v.split(":");
    return kind && id ? { personKind: kind, personId: Number(id) } : null;
  };
  const endOf = (from: number, to: number) => (to <= from ? to + 1440 : to);

  if (!data) return null;
  // A flag on a recommended qualification is a reminder, not a block: the shift counts (ADR 0046).
  const flagText = (f: RosterFlag) =>
    f.kind === "gone"
      ? t("rs1.flag.gone")
      : f.kind === "no_qualification"
        ? t(f.counts ? "rs1.flag.no_qualification_recommended" : "rs1.flag.no_qualification", { name: nameOf(f.personKind, f.personId), qualification: f.qualification ?? "" })
        : t(f.counts ? "rs1.flag.expires_recommended" : "rs1.flag.expires", { name: nameOf(f.personKind, f.personId), qualification: f.qualification ?? "", date: f.expiresOn ?? "" });

  return (
    <section className="space-y-5 rounded-xl border border-slate-200 bg-white p-4" aria-label={t("rs1.title")}>
      <div>
        <h2 className="font-bold">{t("rs1.title")}</h2>
        <p className="mt-0.5 text-xs text-slate-600">{t("rs1.intro")}</p>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {notice && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{notice}</p>}

      <ManagerOnly may="roster">
        {/* Roles */}
        <div>
          <h3 className="text-sm font-semibold">{t("rs1.roles")}</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {data.roles.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <span className={r.active ? "font-medium" : "font-medium text-slate-400"}>{roleName(t, r)}</span>
                <span className="text-xs text-slate-500">
                  {r.qualification ? t("rs1.needsQualLevel", { qualification: r.qualification, level: t(`rs1.level.${r.qualificationLevel ?? "venue_required"}` as StaffPhrase) }) : t("rs1.roleQualNone")}
                </span>
                {!r.active && <span className="text-xs text-slate-400">{t("rs1.roleOffTag")}</span>}
                <RoleEdit venueId={venue.id} role={r} busy={busy} onSave={(patch) => change({ action: "role_save", id: r.id, ...patch })} t={t} />
                {r.active && (
                  <button type="button" disabled={busy} className={button} onClick={() => void change({ action: "role_save", id: r.id, active: false })}>
                    {t("rs1.roleOff")}
                  </button>
                )}
                {!r.active && (
                  <button type="button" disabled={busy} className={button} onClick={() => void change({ action: "role_save", id: r.id, active: true })}>
                    {t("rs1.roleOn")}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <input aria-label={t("rs1.roleName")} placeholder={t("rs1.roleName")} value={roleDraft.name} onChange={(e) => setRoleDraft({ ...roleDraft, name: e.target.value })} className={field} />
            <input aria-label={t("rs1.roleQual")} placeholder={t("rs1.roleQual")} value={roleDraft.qualification} onChange={(e) => setRoleDraft({ ...roleDraft, qualification: e.target.value })} className={field} />
            <button
              type="button"
              disabled={busy || roleDraft.name.trim().length < 2}
              className={button}
              onClick={async () => {
                if (await change({ action: "role_save", name: roleDraft.name, qualification: roleDraft.qualification })) setRoleDraft({ name: "", qualification: "" });
              }}
            >
              {t("rs1.roleAdd")}
            </button>
          </div>
        </div>
      </ManagerOnly>

      {/* Rules */}
      <div>
        <h3 className="text-sm font-semibold">{t("rs1.rules")}</h3>
        {data.rules.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">{t("rs1.noRules")}</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm">
            {data.rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {t("rs1.ruleLine", {
                    n: r.needed,
                    role: roleOf(r.roleId),
                    activity: r.activity ? sportLabel(t.customer, r.activity) : t("rs1.ruleAnyActivity"),
                    resource: r.courtId ? (venue.courts.find((c) => c.id === r.courtId)?.name ?? String(r.courtId)) : t("rs1.ruleAnyResource"),
                  })}
                </span>
                <ManagerOnly may="roster" note={false}>
                  <button type="button" disabled={busy} className={button} onClick={() => void change({ action: "rule_remove", id: r.id })}>
                    {t("rs1.remove")}
                  </button>
                </ManagerOnly>
              </li>
            ))}
          </ul>
        )}
        <ManagerOnly may="roster" note={false}>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <select aria-label={t("rs1.ruleResource")} value={ruleDraft.courtId} onChange={(e) => setRuleDraft({ ...ruleDraft, courtId: e.target.value })} className={field}>
              <option value="">{t("rs1.ruleAnyResource")}</option>
              {venue.courts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select aria-label={t("rs1.ruleActivity")} value={ruleDraft.activity} onChange={(e) => setRuleDraft({ ...ruleDraft, activity: e.target.value })} className={field}>
              <option value="">{t("rs1.ruleAnyActivity")}</option>
              {sports.map((s) => (
                <option key={s} value={s}>
                  {sportLabel(t.customer, s)}
                </option>
              ))}
            </select>
            <select aria-label={t("rs1.ruleRole")} value={ruleDraft.roleId} onChange={(e) => setRuleDraft({ ...ruleDraft, roleId: e.target.value })} className={field}>
              <option value="">{t("rs1.chooseRole")}</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {roleName(t, r)}
                </option>
              ))}
            </select>
            <input aria-label={t("rs1.ruleNeeded")} type="number" min={1} max={20} value={ruleDraft.needed} onChange={(e) => setRuleDraft({ ...ruleDraft, needed: e.target.value })} className={`${field} w-16`} />
            <button
              type="button"
              disabled={busy || !ruleDraft.roleId || (!ruleDraft.courtId && !ruleDraft.activity)}
              className={button}
              onClick={() =>
                void change({
                  action: "rule_set",
                  courtId: ruleDraft.courtId ? Number(ruleDraft.courtId) : null,
                  activity: ruleDraft.activity || null,
                  roleId: Number(ruleDraft.roleId),
                  needed: Number(ruleDraft.needed),
                })
              }
            >
              {t("rs1.ruleAdd")}
            </button>
          </div>
        </ManagerOnly>
      </div>

      {/* Warnings */}
      {data.flags.length > 0 && (
        <ul className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900" aria-label={t("rs1.flags")}>
          {data.flags.map((f, i) => (
            <li key={i}>{flagText(f)}</li>
          ))}
        </ul>
      )}

      {/* The weekly roster */}
      <div>
        <h3 className="text-sm font-semibold">{t("rs1.week")}</h3>
        {people.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">{t("rs1.nobody")}</p>
        ) : (
          <div className="mt-1 overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th scope="col" className="py-1 pr-2 font-medium">
                    {t("rs1.person")}
                  </th>
                  {WEEK.map((d) => (
                    <th scope="col" key={d} className="px-1 py-1 font-medium">
                      {dayName(t, d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={`${p.kind}:${p.id}`} className="border-t border-slate-100 align-top">
                    <th scope="row" className="py-1 pr-2 text-left font-medium">
                      {p.name}
                      {p.kind === "coach" && <span className="ml-1 font-normal text-slate-400">{t("rs1.coachTag")}</span>}
                    </th>
                    {WEEK.map((d) => (
                      <td key={d} className="px-1 py-1">
                        {data.shifts
                          .filter((s) => s.personKind === p.kind && s.personId === p.id && s.weekday === d)
                          .map((s) => (
                            <div key={s.id} className="mb-0.5 flex items-center gap-1 rounded bg-slate-50 px-1 py-0.5">
                              <span>
                                {times(s.fromMin, s.toMin)} {roleOf(s.roleId)}
                              </span>
                              <ManagerOnly may="roster" note={false}>
                                <button
                                  type="button"
                                  disabled={busy}
                                  aria-label={t("rs1.removeShift", { person: p.name, role: roleOf(s.roleId), time: times(s.fromMin, s.toMin) })}
                                  className="font-semibold text-red-700"
                                  onClick={() => void change({ action: "shift_remove", id: s.id })}
                                >
                                  ×
                                </button>
                              </ManagerOnly>
                            </div>
                          ))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ManagerOnly may="roster" note={false}>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <select aria-label={t("rs1.person")} value={shiftDraft.person} onChange={(e) => setShiftDraft({ ...shiftDraft, person: e.target.value })} className={field}>
              <option value="">{t("rs1.choosePerson")}</option>
              {people.map((p) => (
                <option key={`${p.kind}:${p.id}`} value={`${p.kind}:${p.id}`}>
                  {p.name}
                </option>
              ))}
            </select>
            <select aria-label={t("rs1.ruleRole")} value={shiftDraft.roleId} onChange={(e) => setShiftDraft({ ...shiftDraft, roleId: e.target.value })} className={field}>
              <option value="">{t("rs1.chooseRole")}</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {roleName(t, r)}
                </option>
              ))}
            </select>
            <select aria-label={t("rs1.weekday")} value={shiftDraft.weekday} onChange={(e) => setShiftDraft({ ...shiftDraft, weekday: e.target.value })} className={field}>
              {WEEK.map((d) => (
                <option key={d} value={d}>
                  {dayName(t, d)}
                </option>
              ))}
            </select>
            <TimeField label={t("rs1.shiftFrom")} value={shiftDraft.from} onChange={(from) => setShiftDraft({ ...shiftDraft, from })} />
            <TimeField label={t("rs1.shiftTo")} value={shiftDraft.to} onChange={(to) => setShiftDraft({ ...shiftDraft, to })} />
            {shiftDraft.to <= shiftDraft.from && <span className="text-xs text-slate-500">{t("rs1.nextDay")}</span>}
            <button
              type="button"
              disabled={busy || !shiftDraft.person || !shiftDraft.roleId}
              className={button}
              onClick={() => {
                const who = splitPerson(shiftDraft.person);
                if (who) void change({ action: "shift_add", ...who, roleId: Number(shiftDraft.roleId), weekday: Number(shiftDraft.weekday), fromMin: shiftDraft.from, toMin: endOf(shiftDraft.from, shiftDraft.to) });
              }}
            >
              {t("rs1.shiftAdd")}
            </button>
          </div>
        </ManagerOnly>
      </div>

      {/* Extra shifts and leave */}
      <div>
        <h3 className="text-sm font-semibold">{t("rs1.exceptions")}</h3>
        {data.exceptions.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">{t("rs1.exNone")}</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm">
            {data.exceptions.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {e.kind === "extra"
                    ? t("rs1.exLine.extra", { name: nameOf(e.personKind, e.personId), role: roleOf(e.roleId), date: e.date, time: times(e.fromMin ?? 0, e.toMin ?? 0) })
                    : t("rs1.exLine.leave", { name: nameOf(e.personKind, e.personId), date: e.date, time: e.fromMin === null ? t("rs1.exWholeDay") : times(e.fromMin, e.toMin ?? 1440) })}
                </span>
                <ManagerOnly may="roster" note={false}>
                  <button type="button" disabled={busy} className={button} onClick={() => void change({ action: "exception_remove", id: e.id })}>
                    {t("rs1.remove")}
                  </button>
                </ManagerOnly>
              </li>
            ))}
          </ul>
        )}
        <ManagerOnly may="roster" note={false}>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <select aria-label={t("rs1.person")} value={exDraft.person} onChange={(e) => setExDraft({ ...exDraft, person: e.target.value })} className={field}>
              <option value="">{t("rs1.choosePerson")}</option>
              {people.map((p) => (
                <option key={`${p.kind}:${p.id}`} value={`${p.kind}:${p.id}`}>
                  {p.name}
                </option>
              ))}
            </select>
            <select aria-label={t("rs1.exKind")} value={exDraft.kind} onChange={(e) => setExDraft({ ...exDraft, kind: e.target.value })} className={field}>
              <option value="leave">{t("rs1.exKind.leave")}</option>
              <option value="extra">{t("rs1.exKind.extra")}</option>
            </select>
            <input aria-label={t("rs1.exDate")} type="date" value={exDraft.date} onChange={(e) => setExDraft({ ...exDraft, date: e.target.value })} className={field} />
            {exDraft.kind === "extra" && (
              <select aria-label={t("rs1.ruleRole")} value={exDraft.roleId} onChange={(e) => setExDraft({ ...exDraft, roleId: e.target.value })} className={field}>
                <option value="">{t("rs1.chooseRole")}</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {roleName(t, r)}
                  </option>
                ))}
              </select>
            )}
            {exDraft.kind === "leave" && (
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={exDraft.whole} onChange={(e) => setExDraft({ ...exDraft, whole: e.target.checked })} />
                {t("rs1.exWholeDay")}
              </label>
            )}
            {(exDraft.kind === "extra" || !exDraft.whole) && (
              <>
                <TimeField label={t("rs1.shiftFrom")} value={exDraft.from} onChange={(from) => setExDraft({ ...exDraft, from })} />
                <TimeField label={t("rs1.shiftTo")} value={exDraft.to} onChange={(to) => setExDraft({ ...exDraft, to })} />
              </>
            )}
            <button
              type="button"
              disabled={busy || !exDraft.person || !exDraft.date || (exDraft.kind === "extra" && !exDraft.roleId)}
              className={button}
              onClick={async () => {
                const who = splitPerson(exDraft.person);
                if (!who) return;
                const timed = exDraft.kind === "extra" || !exDraft.whole;
                await change({
                  action: "exception_add",
                  ...who,
                  kind: exDraft.kind,
                  date: exDraft.date,
                  ...(exDraft.kind === "extra" ? { roleId: Number(exDraft.roleId) } : {}),
                  ...(timed ? { fromMin: exDraft.from, toMin: exDraft.kind === "extra" ? endOf(exDraft.from, exDraft.to) : Math.max(exDraft.to, exDraft.from + 1) } : {}),
                });
              }}
            >
              {t("rs1.exAdd")}
            </button>
          </div>
        </ManagerOnly>
      </div>

      {/* Qualifications */}
      <div>
        <h3 className="text-sm font-semibold">{t("rs1.quals")}</h3>
        <p className="mt-0.5 text-xs text-slate-600">{t("rs1.qualIntro")}</p>
        <ul className="mt-1 space-y-1 text-sm">
          {data.qualifications.map((q) => (
            <li key={q.id} className="flex flex-wrap items-center gap-2">
              <span>
                {t("rs1.qualLine", {
                  name: nameOf(q.personKind, q.personId),
                  qualification: q.qualification,
                  until: q.expiresOn ? t("rs1.qualUntil", { date: q.expiresOn }) : t("rs1.qualNoEnd"),
                })}
                {q.reference ? ` · ${q.reference}` : ""}
              </span>
              <ManagerOnly may="roster" note={false}>
                <button type="button" disabled={busy} className={button} onClick={() => void change({ action: "qualification_revoke", id: q.id })}>
                  {t("rs1.qualRevoke")}
                </button>
              </ManagerOnly>
            </li>
          ))}
        </ul>
        <ManagerOnly may="roster" note={false}>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <select aria-label={t("rs1.person")} value={qualDraft.person} onChange={(e) => setQualDraft({ ...qualDraft, person: e.target.value })} className={field}>
              <option value="">{t("rs1.choosePerson")}</option>
              {people.map((p) => (
                <option key={`${p.kind}:${p.id}`} value={`${p.kind}:${p.id}`}>
                  {p.name}
                </option>
              ))}
            </select>
            <input aria-label={t("rs1.qualName")} placeholder={t("rs1.qualName")} list="rs1-quals" value={qualDraft.qualification} onChange={(e) => setQualDraft({ ...qualDraft, qualification: e.target.value })} className={field} />
            <datalist id="rs1-quals">
              {data.roles.filter((r) => r.qualification).map((r) => (
                <option key={r.id} value={r.qualification!} />
              ))}
            </datalist>
            <input aria-label={t("rs1.qualRef")} placeholder={t("rs1.qualRef")} value={qualDraft.reference} onChange={(e) => setQualDraft({ ...qualDraft, reference: e.target.value })} className={field} />
            <input aria-label={t("rs1.qualLastDay")} type="date" value={qualDraft.expiresOn} onChange={(e) => setQualDraft({ ...qualDraft, expiresOn: e.target.value })} className={field} />
            <button
              type="button"
              disabled={busy || !qualDraft.person || qualDraft.qualification.trim() === ""}
              className={button}
              onClick={async () => {
                const who = splitPerson(qualDraft.person);
                if (who && (await change({ action: "qualification_add", ...who, qualification: qualDraft.qualification, reference: qualDraft.reference, expiresOn: qualDraft.expiresOn || null })))
                  setQualDraft({ ...qualDraft, qualification: "", reference: "", expiresOn: "" });
              }}
            >
              {t("rs1.qualAdd")}
            </button>
          </div>
        </ManagerOnly>
      </div>

      <UncoveredSessions venueId={venue.id} />
      <MyCalendar />
    </section>
  );
}

/**
 * Change a role's qualification in place: its name, how firmly it is asked (recommended, required by the venue, or declared a legal
 * requirement with the reference the venue gives; ADR 0046), and a check of what the change would do before it is made.
 */
function RoleEdit({ venueId, role, busy, onSave, t }: { venueId: number; role: RosterRole; busy: boolean; onSave: (patch: Record<string, unknown>) => void; t: StaffT }) {
  const [value, setValue] = useState(role.qualification ?? "");
  const [level, setLevel] = useState<QualificationLevel>(role.qualificationLevel ?? "venue_required");
  const [reference, setReference] = useState(role.qualificationReference ?? "");
  const [preview, setPreview] = useState<RoleChangePreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const changed = value !== (role.qualification ?? "") || level !== (role.qualificationLevel ?? "venue_required") || (level === "legally_required" && reference !== (role.qualificationReference ?? ""));
  const patch = { qualification: value, qualificationLevel: level, qualificationReference: level === "legally_required" ? reference : null };

  async function check() {
    setProblem(null);
    const res = await fetch("/api/admin/roster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, action: "role_preview", id: role.id, ...patch }),
    });
    const out = await readJson(res);
    if (!res.ok) {
      setPreview(null);
      setProblem(t.err(out, t("rs1.saveFailed")));
    } else setPreview(out.preview);
  }

  return (
    <span className="flex flex-wrap items-center gap-1">
      <input aria-label={t("rs1.roleQualOf", { role: roleName(t, role) })} value={value} onChange={(e) => { setValue(e.target.value); setPreview(null); }} className={`${field} w-48`} />
      <select aria-label={t("rs1.levelOf", { role: roleName(t, role) })} value={level} onChange={(e) => { setLevel(e.target.value as QualificationLevel); setPreview(null); }} className={field}>
        {QUALIFICATION_LEVELS.map((l) => (
          <option key={l} value={l}>
            {t(`rs1.level.${l}` as StaffPhrase)}
          </option>
        ))}
      </select>
      {level === "legally_required" && (
        <input aria-label={t("rs1.levelRef")} placeholder={t("rs1.levelRef")} value={reference} onChange={(e) => setReference(e.target.value)} className={`${field} w-56`} />
      )}
      <button type="button" disabled={busy || !changed} className={button} onClick={() => void check()}>
        {t("rs1.levelCheck")}
      </button>
      <button type="button" disabled={busy || !changed} className={button} onClick={() => onSave(patch)}>
        {t("rs1.roleSave")}
      </button>
      <span className="basis-full text-xs text-slate-500">{t(`rs1.levelHelp.${level}` as StaffPhrase)}</span>
      {problem && <span className="basis-full text-xs text-red-700">{problem}</span>}
      {preview && (
        <span className="basis-full text-xs text-slate-700" role="status">
          {preview.shiftsWithoutIt === 0 && preview.becomeUncovered.length === 0 && preview.becomeCovered.length === 0
            ? t("rs1.preview.none")
            : [
                preview.shiftsWithoutIt > 0 ? t.plural("rs1.preview.shifts", preview.shiftsWithoutIt) : "",
                preview.becomeUncovered.length > 0 ? t.plural("rs1.preview.uncovered", preview.becomeUncovered.length) : "",
                preview.becomeCovered.length > 0 ? t.plural("rs1.preview.covered", preview.becomeCovered.length) : "",
              ]
                .filter(Boolean)
                .join(" ")}
        </span>
      )}
    </span>
  );
}

/** The manager's worklist of sessions without their supervisors, and what a manager does about each (also on the needs-attention panel). */
export function UncoveredSessions({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const clock = (minute: number) => formatMinute(minute, t.locale);
  const [sessions, setSessions] = useState<UncoveredSession[] | null>(null);
  const [advisory, setAdvisory] = useState<AdvisorySession[]>([]);
  const [overview, setOverview] = useState<Pick<Overview, "people" | "roles"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { person: string; reason: string }>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/roster/uncovered?venueId=${venueId}`, { cache: "no-store" });
    if (res.ok) {
      const out = await readJson(res);
      setSessions(out.sessions);
      setAdvisory(out.advisory ?? []);
    }
  }, [venueId]);
  useEffect(() => {
    void load();
    const now = () => void load();
    window.addEventListener("roster:changed", now);
    return () => window.removeEventListener("roster:changed", now);
  }, [load]);
  useEffect(() => {
    if (!sessions || sessions.length === 0 || overview) return;
    void (async () => {
      const res = await fetch(`/api/admin/roster?venueId=${venueId}`, { cache: "no-store" });
      if (res.ok) {
        const o = await readJson(res);
        setOverview({ people: o.people, roles: o.roles });
      }
    })();
  }, [sessions, overview, venueId]);

  async function decide(s: UncoveredSession, roleId: number, action: "cover" | "override") {
    const key = `${s.kind}:${s.id}:${roleId}`;
    const d = draft[key] ?? { person: "", reason: "" };
    setBusy(true);
    setError(null);
    try {
      const who = d.person.split(":");
      const res = await fetch("/api/admin/roster/uncovered", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, action, kind: s.kind, id: s.id, roleId, ...(action === "cover" ? { personKind: who[0], personId: Number(who[1]) } : { reason: d.reason }) }),
      });
      const out = await readJson(res);
      if (!res.ok) setError(t.err(out, t("rs1.saveFailed")));
      else {
        setSessions(out.sessions);
        window.dispatchEvent(new Event("attention:refresh"));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!sessions) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold">{t("rs1.uncovered")}</h3>
      <p className="mt-0.5 text-xs text-slate-600">{t("rs1.uncoveredIntro")}</p>
      {error && <p className="mt-1 text-sm text-red-700">{error}</p>}
      {sessions.length === 0 ? (
        <p className="mt-1 text-xs text-slate-500">{t("rs1.uncoveredNone")}</p>
      ) : (
        <ul className="mt-1 space-y-2 text-sm">
          {sessions.map((s) => (
            <li key={`${s.kind}:${s.id}`} className="rounded-lg border border-amber-200 bg-amber-50/50 p-2">
              <div className="font-medium">
                {s.date} {clock(s.startMin)}–{clock(s.endMin)} · {s.courtName} · {s.kind === "booking" ? t("rs1.kindBooking", { code: s.code ?? "", name: s.name }) : t("rs1.kindClass", { name: s.name })}
              </div>
              {s.roles.map((r) => {
                const key = `${s.kind}:${s.id}:${r.roleId}`;
                const d = draft[key] ?? { person: "", reason: "" };
                const roleLabel = overview?.roles.find((x) => x.id === r.roleId);
                return (
                  <div key={r.roleId} className="mt-1">
                    <div className="text-xs text-amber-900">
                      {t("rs1.uncoveredNeeds", {
                        n: r.needed,
                        role: roleLabel ? roleName(t, roleLabel) : r.roleName,
                        gaps: r.gaps.map((g) => `${clock(g.start)}–${clock(g.end)}`).join(", "),
                      })}
                    </div>
                    <ManagerOnly may="rosterDecide" note={false}>
                      <div className="mt-1 flex flex-wrap items-end gap-2">
                        <select aria-label={t("rs1.coverWho")} value={d.person} onChange={(e) => setDraft({ ...draft, [key]: { ...d, person: e.target.value } })} className={field}>
                          <option value="">{t("rs1.coverWho")}</option>
                          {(overview?.people ?? []).map((p) => (
                            <option key={`${p.kind}:${p.id}`} value={`${p.kind}:${p.id}`}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        <button type="button" disabled={busy || !d.person} className={button} onClick={() => void decide(s, r.roleId, "cover")}>
                          {t("rs1.cover")}
                        </button>
                        {roleLabel?.qualification && roleLabel.qualificationLevel === "legally_required" ? (
                          <span className="basis-full text-xs text-amber-900">{t("rs1.standLegal")}</span>
                        ) : (
                          <>
                            <input aria-label={t("rs1.standReason")} placeholder={t("rs1.standReason")} value={d.reason} onChange={(e) => setDraft({ ...draft, [key]: { ...d, reason: e.target.value } })} className={`${field} w-56`} />
                            <button type="button" disabled={busy || d.reason.trim().length < 3} className={button} onClick={() => void decide(s, r.roleId, "override")}>
                              {t("rs1.letStand")}
                            </button>
                          </>
                        )}
                      </div>
                    </ManagerOnly>
                  </div>
                );
              })}
            </li>
          ))}
        </ul>
      )}
      {advisory.length > 0 && (
        <div className="mt-3" data-testid="roster-advisory">
          <h3 className="text-sm font-semibold">{t("rs1.advisory")}</h3>
          <p className="mt-0.5 text-xs text-slate-600">{t("rs1.advisoryIntro")}</p>
          <ul className="mt-1 space-y-1 text-sm">
            {advisory.map((s) => (
              <li key={`${s.kind}:${s.id}`} className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                <div className="font-medium">
                  {s.date} {clock(s.startMin)}–{clock(s.endMin)} · {s.courtName} · {s.kind === "booking" ? t("rs1.kindBooking", { code: s.code ?? "", name: s.name }) : t("rs1.kindClass", { name: s.name })}
                </div>
                {s.people.map((p) => (
                  <div key={`${p.roleKey}:${p.personName}`} className="text-xs text-slate-700">
                    {t(`rs1.advisory.${p.why}` as StaffPhrase, { role: t.known(`rs1.role.${p.roleKey}`) ?? p.roleName, person: p.personName, qualification: p.qualification })}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A link to one's own shifts as a calendar: any member of staff's, for themselves. */
function MyCalendar() {
  const t = useStaffT();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function make() {
    setError(null);
    const res = await fetch("/api/admin/roster/my-calendar", { method: "POST" });
    const out = await readJson(res);
    if (!res.ok) setError(t.err(out, t("rs1.saveFailed")));
    else setUrl(out.url);
  }
  async function stop() {
    setError(null);
    const res = await fetch("/api/admin/roster/my-calendar", { method: "DELETE" });
    if (!res.ok) setError(t.err(await readJson(res), t("rs1.saveFailed")));
    else setUrl(null);
  }
  return (
    <div>
      <h3 className="text-sm font-semibold">{t("rs1.myCal")}</h3>
      <p className="mt-0.5 text-xs text-slate-600">{t("rs1.myCalNote")}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button type="button" className={button} onClick={() => void make()}>
          {t("rs1.myCalMake")}
        </button>
        <button type="button" className={button} onClick={() => void stop()}>
          {t("rs1.myCalStop")}
        </button>
      </div>
      {url && (
        <p className="mt-1 break-all text-xs">
          {t("rs1.myCalShown")} <code>{url}</code>
        </p>
      )}
      {error && <p className="mt-1 text-sm text-red-700">{error}</p>}
    </div>
  );
}
