"use client";

import { useState } from "react";
import type { ApprovalQuestion } from "@/lib/approvals";
import { hasPhrase, sportLabel, translateError, type Phrase, type T } from "@/lib/i18n";
import { useT } from "@/components/Language";

/** What the venue asks, as GET /api/my/approvals?venueId&sport gives it. */
export interface ApplyInfo {
  venueId: number;
  venueName: string;
  sport: string;
  kind: "operational" | "certification";
  intro: string | null;
  declaration: string | null;
  documentLabel: string | null;
  /** Why the venue needs the document (lib/approvals.ts). */
  documentPurpose?: string | null;
  videoUrl: string | null;
  inPerson: string | null;
  questions: ApprovalQuestion[];
  validDays: number | null;
  holdHours: number;
  courts: { id: number; name: string }[];
  waiverText: string | null;
  adult: boolean | null;
  /** The waiver, to agree on behalf of somebody the account manages (ADR 0022). */
  waiverForOthers?: string | null;
  /** People the account's adult manages, who may be applied for. */
  people?: { id: number; displayName: string; relationship: "parent" | "guardian" | "other" }[];
}

/** A refusal about an application, in the customer's language: by its code where it has one. */
export function explainApproval(t: T, body: { error?: string; code?: string } | null | undefined): string {
  // Document refusals (lib/approval-documents.ts) have their own words; so do those about somebody managed.
  const code = body?.code ?? "";
  const key = code
    ? code.startsWith("APRDOC_")
      ? `aprdoc.err.${code}`
      : code.startsWith("GUARD_") || code.startsWith("APR_CHILD_")
        ? `guard.err.${code}`
        : `apr.err.${code}`
    : "";
  if (key && hasPhrase(key)) return t(key as Phrase);
  return translateError(t, body) || t("apr.failed");
}

/** "HH:MM" as minutes of the day, or NaN. */
export function minutesOf(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** A slot to ask for: a resource, a day, a start and an end. */
export function SlotFields({
  courts,
  value,
  onChange,
}: {
  courts: { id: number; name: string }[];
  value: { courtId: string; date: string; start: string; end: string };
  onChange: (v: { courtId: string; date: string; start: string; end: string }) => void;
}) {
  const t = useT();
  const field = "mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm";
  return (
    <div className="flex flex-wrap gap-2 text-xs text-slate-600">
      <label>
        {t("apr.slotWhere")}
        <select value={value.courtId} onChange={(e) => onChange({ ...value, courtId: e.target.value })} className={field}>
          <option value="">—</option>
          {courts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("apr.slotDate")}
        <input type="date" value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} className={field} />
      </label>
      <label>
        {t("apr.slotFrom")}
        <input type="time" step={300} value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value })} className={field} />
      </label>
      <label>
        {t("apr.slotUntil")}
        <input type="time" step={300} value={value.end} onChange={(e) => onChange({ ...value, end: e.target.value })} className={field} />
      </label>
    </div>
  );
}

/** The slot as the server takes it, or null when none is chosen. */
export function slotBody(v: { courtId: string; date: string; start: string; end: string }) {
  if (!v.courtId || !v.date || !v.start || !v.end) return null;
  return { courtId: Number(v.courtId), date: v.date, start: minutesOf(v.start), end: minutesOf(v.end) };
}

/**
 * Applying to be approved for an activity: what the venue asks, the
 * declarations, a document where it needs one, and a slot if wanted.
 */
export function ApprovalForm({ info, onDone, initialFor }: { info: ApplyInfo; onDone: () => void; initialFor?: number | null }) {
  const t = useT();
  // Who it is for: the account's adult, or somebody they manage (applied for, and agreed for, by the adult).
  const people = info.people ?? [];
  const [forId, setForId] = useState<number | null>(initialFor && people.some((p) => p.id === initialFor) ? initialFor : null);
  const person = people.find((p) => p.id === forId) ?? null;
  const [authority, setAuthority] = useState(false);
  const waiverShown = person ? (info.waiverForOthers ?? null) : info.waiverText;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [declaration, setDeclaration] = useState(false);
  const [watched, setWatched] = useState(false);
  const [waiver, setWaiver] = useState(false);
  const [adult, setAdult] = useState<boolean | null>(info.adult);
  const [guardianName, setGuardianName] = useState("");
  const [guardianDeclaration, setGuardianDeclaration] = useState(false);
  const [certReference, setCertReference] = useState("");
  const [certExpiresOn, setCertExpiresOn] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [slot, setSlot] = useState({ courtId: "", date: "", start: "", end: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activity = sportLabel(t, info.sport);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const data = {
      venueId: info.venueId,
      sport: info.sport,
      answers,
      declaration,
      videoWatched: watched,
      waiver,
      ...(person
        ? { forPerson: person.id, authority }
        : {
            adult,
            guardianName: adult === false ? guardianName : undefined,
            guardianDeclaration: adult === false ? guardianDeclaration : undefined,
          }),
      certReference: info.kind === "certification" ? certReference : undefined,
      certExpiresOn: info.kind === "certification" ? certExpiresOn : undefined,
      slot: slotBody(slot),
    };
    const form = new FormData();
    form.set("data", JSON.stringify(data));
    for (const f of files) form.append("document", f);
    try {
      const res = await fetch("/api/my/approvals", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(explainApproval(t, body));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("apr.failed"));
    } finally {
      setBusy(false);
    }
  }

  const box = "space-y-2 rounded-lg border border-slate-200 p-3";
  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-teal-200 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold">{t("apr.applyTitle", { activity, venue: info.venueName })}</h2>
        <p className="mt-1 text-sm text-slate-600">{t("apr.applyIntro")}</p>
        {info.intro && <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{info.intro}</p>}
      </div>
      {people.length > 0 && (
        <label className={`block text-sm ${box}`}>
          {t("guard.whoFor")}
          <select
            value={forId ?? ""}
            onChange={(e) => {
              setForId(e.target.value === "" ? null : Number(e.target.value));
              setAuthority(false);
              setWaiver(false);
            }}
            className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">{t("guard.me")}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
      )}
      {info.questions.length > 0 && (
        <div className={box}>
          {info.questions.map((q) => (
            <label key={q.id} className="block text-sm">
              {q.text} {q.required ? <span className="text-red-600">*</span> : <span className="text-xs text-slate-400">{t("apr.optional")}</span>}
              <textarea
                rows={2}
                required={q.required}
                maxLength={1000}
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
          ))}
        </div>
      )}
      {info.kind === "certification" && (
        <div className={box}>
          <p className="text-sm font-medium">{t("apr.certTitle")}</p>
          <input required placeholder={t("apr.certReference")} value={certReference} onChange={(e) => setCertReference(e.target.value)} className="block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
          <label className="block text-xs text-slate-600">
            {t("apr.certExpires")}
            <input type="date" required value={certExpiresOn} onChange={(e) => setCertExpiresOn(e.target.value)} className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
          </label>
        </div>
      )}
      {info.documentLabel && (
        <div className={box}>
          <label className="block text-sm">
            {t("apr.documentAsk", { what: info.documentLabel })}
            <input
              type="file"
              multiple
              required
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 3))}
              className="mt-1 block text-sm"
            />
          </label>
          {info.documentPurpose && <p className="text-xs text-slate-600">{t("aprdoc.why", { why: info.documentPurpose })}</p>}
          <p className="text-xs text-slate-500">{t("aprdoc.note")}</p>
        </div>
      )}
      {info.videoUrl && (
        <div className={box}>
          <a href={info.videoUrl} target="_blank" rel="noreferrer" className="text-sm font-medium text-teal-700 underline">
            ▶ {t("apr.videoLink")}
          </a>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={watched} onChange={(e) => setWatched(e.target.checked)} className="mt-1" required />
            {t("apr.videoWatched")}
          </label>
        </div>
      )}
      {info.declaration && (
        <label className={`flex items-start gap-2 text-sm ${box}`}>
          <input type="checkbox" checked={declaration} onChange={(e) => setDeclaration(e.target.checked)} className="mt-1" required />
          <span className="whitespace-pre-line">{info.declaration}</span>
        </label>
      )}
      {waiverShown && (
        <div className={box}>
          <div className="max-h-40 overflow-y-auto whitespace-pre-line rounded bg-slate-50 p-2 text-xs text-slate-700">{waiverShown}</div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={waiver} onChange={(e) => setWaiver(e.target.checked)} className="mt-1" required />
            {person ? t("guard.waiverOnBehalf", { name: person.displayName }) : t("apr.waiverAgree")}
          </label>
        </div>
      )}
      {person && (
        <div className={box}>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={authority} onChange={(e) => setAuthority(e.target.checked)} className="mt-1" required />
            {t("guard.authorityApply", { name: person.displayName, relationship: t(`guard.rel.${person.relationship}`) })}
          </label>
          <p className="text-xs text-slate-500">{t("guard.declaredNote")}</p>
        </div>
      )}
      {!person && (
      <fieldset className={box}>
        <legend className="px-1 text-sm font-medium">{t("apr.ageTitle")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="adult" checked={adult === true} onChange={() => setAdult(true)} required />
          {t("apr.adultYes")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="adult" checked={adult === false} onChange={() => setAdult(false)} />
          {t("apr.adultNo")}
        </label>
        {adult === false && (
          <div className="space-y-2 pl-6">
            <input
              required
              placeholder={t("apr.guardianName")}
              value={guardianName}
              onChange={(e) => setGuardianName(e.target.value)}
              className="block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={guardianDeclaration} onChange={(e) => setGuardianDeclaration(e.target.checked)} className="mt-1" required />
              {t("apr.guardianDeclaration", { activity, venue: info.venueName })}
            </label>
          </div>
        )}
        <p className="text-xs text-slate-500">{t("apr.declaredNote")}</p>
      </fieldset>
      )}
      {info.inPerson && <p className="rounded-lg bg-violet-50 p-3 text-sm text-violet-900">{t("apr.inPersonNote", { step: info.inPerson })}</p>}
      {info.courts.length > 0 && (
        <div className={box}>
          <p className="text-sm font-medium">{info.inPerson ? t("apr.slotTitleSession") : t("apr.slotTitle")}</p>
          <p className="text-xs text-slate-500">{t("apr.slotNote", { hours: info.holdHours })}</p>
          <SlotFields courts={info.courts} value={slot} onChange={setSlot} />
        </div>
      )}
      <p className="text-xs text-slate-500">{info.validDays ? t("apr.lasts", { n: info.validDays }) : t("apr.lastsUntilTakenBack")} {t("apr.nothingCharged")}</p>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <button type="submit" disabled={busy} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
        {t("apr.send")}
      </button>
    </form>
  );
}
