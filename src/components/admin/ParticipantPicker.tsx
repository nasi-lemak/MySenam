"use client";

import { useState } from "react";
import { useStaffT } from "./StaffLanguage";

export interface PickedParticipant {
  id: number;
  displayName: string;
}

interface Candidate {
  id: number;
  displayName: string;
  birthYear: number | null;
  linked: boolean;
  guardians: { id: number; name: string; relationship: "parent" | "guardian" | "other"; provenance: string; account: boolean }[];
  inductionId: number | null;
}

const RELATIONSHIPS = ["parent", "guardian", "other"] as const;
const input = "rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none";

/**
 * Who something recorded at the counter is for (lib/participants.ts; ADR
 * 0023): the holder of the number typed, or a participant this venue knows
 * whose guardian is on that number (a child, most often), or somebody new,
 * added with the guardian's declaration made to the member of staff. Or a
 * child the venue knows whose recorded guardian is on another number: found
 * by that number, the adult here is invited to become a guardian too (a
 * code they accept on their own account; lib/guardian-requests.ts), never
 * made one on the spot, and never a second record of the same child. Staff
 * choose; the number only finds candidates and never decides whose it is.
 */
export function ParticipantPicker({
  venueId,
  phone,
  guardianName,
  value = null,
  onChange = () => {},
  showInducted = false,
  many,
}: {
  venueId: number;
  phone: string;
  /** The name typed for the number holder: the guardian's, when adding somebody new. */
  guardianName: string;
  value?: PickedParticipant | null;
  onChange?: (picked: PickedParticipant | null) => void;
  showInducted?: boolean;
  /**
   * Several at once, for a booking at the counter (lib/participant-bookings.ts):
   * who is ticked, and whether the number holder takes a place too.
   */
  many?: { values: PickedParticipant[]; holderTakesPart: boolean; onChange: (values: PickedParticipant[], holderTakesPart: boolean) => void };
}) {
  const t = useStaffT();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ displayName: "", birthYear: "", relationship: "parent", authority: false });
  const [error, setError] = useState<string | null>(null);
  const tooShort = phone.replace(/\D/g, "").length < 7;
  // A child the venue knows whose recorded guardian is on another number: the adult here is
  // invited to become a guardian too, by a code for their own account (lib/guardian-requests.ts).
  const [other, setOther] = useState<{
    phone: string;
    found: Candidate[] | null;
    chosen: number | null;
    email: string;
    made: { code: string; expiresAt: string; consentPossible: boolean; name: string } | null;
  } | null>(null);
  const adult = guardianName.trim();

  async function findOther() {
    if (!other) return;
    setError(null);
    try {
      const res = await fetch(`/api/admin/participants?venueId=${venueId}&phone=${encodeURIComponent(other.phone)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setOther({ ...other, found: data.participants, chosen: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  /** A request and its code, shown once: nothing is granted until the adult accepts and a guardian agrees (or a manager's exception). */
  async function invite() {
    if (!other || other.chosen === null) return;
    const child = other.found?.find((c) => c.id === other.chosen);
    if (!child) return;
    setError(null);
    try {
      const res = await fetch(`/api/admin/participants/${child.id}/guardians`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, proposedName: adult, ...(other.email.trim() ? { email: other.email.trim() } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setOther({ ...other, made: { ...data.request, name: child.displayName } });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  async function look() {
    setError(null);
    try {
      const res = await fetch(`/api/admin/participants?venueId=${venueId}&phone=${encodeURIComponent(phone)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setCandidates(data.participants);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  async function create() {
    setError(null);
    try {
      const res = await fetch("/api/admin/participants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId,
          displayName: form.displayName,
          birthYear: form.birthYear.trim() === "" ? null : Number(form.birthYear),
          guardianName,
          guardianPhone: phone,
          relationship: form.relationship,
          authority: form.authority,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setAdding(false);
      setForm({ displayName: "", birthYear: "", relationship: "parent", authority: false });
      await look();
      const made = { id: data.participant.id, displayName: data.participant.displayName };
      if (many) many.onChange([...many.values, made], many.holderTakesPart);
      else onChange(made);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  return (
    <div className="mt-2 w-full space-y-1 text-sm">
      {candidates === null ? (
        <button type="button" disabled={tooShort} onClick={() => void look()} className="text-xs font-medium text-teal-700 underline disabled:text-slate-400">
          {t("ptc.pick.look")}
        </button>
      ) : (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-slate-500">{t("ptc.pick.whoFor")}</legend>
          {many ? (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={many.holderTakesPart} onChange={(e) => many.onChange(many.values, e.target.checked)} />
              {t("pbk.counter.holderToo")}
            </label>
          ) : (
            <label className="flex items-center gap-2">
              <input type="radio" checked={value === null} onChange={() => onChange(null)} />
              {t("ptc.pick.holder")}
            </label>
          )}
          {candidates.map((c) => (
            <label key={c.id} className="flex items-center gap-2">
              {many ? (
                <input
                  type="checkbox"
                  checked={many.values.some((v) => v.id === c.id)}
                  onChange={(e) =>
                    many.onChange(
                      e.target.checked ? [...many.values, { id: c.id, displayName: c.displayName }] : many.values.filter((v) => v.id !== c.id),
                      many.holderTakesPart
                    )
                  }
                />
              ) : (
                <input type="radio" checked={value?.id === c.id} onChange={() => onChange({ id: c.id, displayName: c.displayName })} />
              )}
              <span>
                <span className="font-medium">{c.displayName}</span>
                {c.birthYear ? ` · ${t("ptc.pick.born", { year: c.birthYear })}` : ""}
                {c.guardians.length > 0
                  ? ` · ${t("ptc.pick.guardians", { names: c.guardians.map((g) => `${g.name} (${t(`apr.child.rel.${g.relationship}`)})`).join(", ") })}`
                  : ""}
                {showInducted && c.inductionId !== null ? ` · ${t("ptc.pick.inducted")}` : ""}
              </span>
            </label>
          ))}
          {candidates.length === 0 && <p className="text-xs text-slate-500">{t("ptc.pick.none")}</p>}
          {many && <p className="text-xs text-slate-500">{t("pbk.counter.note")}</p>}
          {other === null ? (
            <button
              type="button"
              onClick={() => setOther({ phone: "", found: null, chosen: null, email: "", made: null })}
              className="block text-xs font-medium text-teal-700 underline"
            >
              {t("gv.g.open")}
            </button>
          ) : (
            <div className="space-y-1 rounded-lg border border-slate-100 bg-slate-50 p-2 text-xs" data-testid="add-guardian">
              {adult.length < 2 ? (
                <p className="text-amber-700">{t("pbk2.g.needName")}</p>
              ) : (
                <>
                  <p className="text-slate-600">{t("gv.g.intro", { adult })}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      aria-label={t("pbk2.g.otherPhone")}
                      placeholder={t("pbk2.g.otherPhone")}
                      inputMode="tel"
                      value={other.phone}
                      onChange={(e) => setOther({ ...other, phone: e.target.value, found: null, chosen: null })}
                      className={`w-44 ${input}`}
                    />
                    <button
                      type="button"
                      disabled={other.phone.replace(/\D/g, "").length < 7}
                      onClick={() => void findOther()}
                      className="font-medium text-teal-700 underline disabled:text-slate-400"
                    >
                      {t("pbk2.g.find")}
                    </button>
                  </div>
                  {other.found !== null && other.found.length === 0 && <p className="text-slate-500">{t("pbk2.g.none")}</p>}
                  {other.found?.map((c) => (
                    <label key={c.id} className="flex items-center gap-2">
                      <input type="radio" name="add-guardian-child" checked={other.chosen === c.id} onChange={() => setOther({ ...other, chosen: c.id })} />
                      <span>
                        <span className="font-medium">{c.displayName}</span>
                        {c.birthYear ? ` · ${t("ptc.pick.born", { year: c.birthYear })}` : ""}
                      </span>
                    </label>
                  ))}
                  {other.chosen !== null && other.made === null && (
                    <>
                      <input
                        type="email"
                        aria-label={t("gv.g.email", { adult })}
                        placeholder={t("gv.g.email", { adult })}
                        value={other.email}
                        onChange={(e) => setOther({ ...other, email: e.target.value })}
                        className={`w-full max-w-sm ${input}`}
                      />
                      <button type="button" onClick={() => void invite()} className="rounded-lg bg-teal-600 px-3 py-1 font-semibold text-white hover:bg-teal-700">
                        {t("gv.g.invite", { adult })}
                      </button>
                    </>
                  )}
                  {other.made && (
                    <div role="status" className="space-y-1 rounded border border-emerald-200 bg-emerald-50 p-2 text-emerald-900">
                      <p>{t("gv.g.code", { adult, code: other.made.code, date: new Date(other.made.expiresAt).toLocaleDateString(), name: other.made.name })}</p>
                      {!other.made.consentPossible && <p className="text-amber-800">{t("gv.g.noConsent", { name: other.made.name })}</p>}
                    </div>
                  )}
                </>
              )}
              <button type="button" onClick={() => setOther(null)} className="block text-slate-600 underline">
                {t("pbk2.g.cancel")}
              </button>
            </div>
          )}
          {!adding ? (
            <button type="button" onClick={() => setAdding(true)} className="text-xs font-medium text-teal-700 underline">
              {t("ptc.pick.addNew")}
            </button>
          ) : (
            <div className="space-y-1 rounded-lg border border-slate-100 bg-slate-50 p-2">
              <div className="flex flex-wrap items-end gap-2">
                <input placeholder={t("ptc.pick.name")} maxLength={40} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} className={`w-40 ${input}`} />
                <input
                  placeholder={t("ptc.pick.birthYear")}
                  inputMode="numeric"
                  maxLength={4}
                  value={form.birthYear}
                  onChange={(e) => setForm({ ...form, birthYear: e.target.value })}
                  className={`w-28 ${input}`}
                />
                <select aria-label={t("ptc.pick.relationship")} value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value })} className={input}>
                  {RELATIONSHIPS.map((r) => (
                    <option key={r} value={r}>
                      {t("ptc.pick.guardianIs", { relationship: t(`apr.child.rel.${r}`) })}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={form.authority} onChange={(e) => setForm({ ...form, authority: e.target.checked })} className="mt-0.5" />
                {t("ptc.pick.declared", { guardian: guardianName.trim() || t("ptc.pick.theGuardian") })}
              </label>
              <p className="text-xs text-slate-500">{t("ptc.pick.note")}</p>
              <button type="button" onClick={() => void create()} className="rounded-lg bg-teal-600 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700">
                {t("ptc.pick.add")}
              </button>
            </div>
          )}
        </fieldset>
      )}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
