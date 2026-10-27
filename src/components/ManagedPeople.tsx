"use client";

import { useCallback, useEffect, useState } from "react";
import type { ManagedPerson, Relationship } from "@/lib/managed-people";
import type { AccountRequests } from "@/lib/guardian-requests";
import { hasPhrase, type Phrase, type T } from "@/lib/i18n";
import { useT } from "@/components/Language";

const RELATIONSHIPS: Relationship[] = ["parent", "guardian", "other"];

/** A refusal about somebody managed, in the customer's language: by its code where it has one. */
export function explainGuard(t: T, body: { error?: string; code?: string; vars?: Record<string, string | number> } | null | undefined): string {
  for (const key of body?.code ? [`guard.err.${body.code}`, `ptc.err.${body.code}`, `pbk.err.${body.code}`, `gv.err.${body.code}`, `gw5.err.${body.code}`] : [])
    if (hasPhrase(key)) return t(key as Phrase, body?.vars);
  return body?.error || t("guard.failed");
}

const EMPTY = { displayName: "", birthYear: "", relationship: "parent" as Relationship, authority: false };
const EMPTY_CODE = { code: "", relationship: "parent" as Relationship, authority: false };

/**
 * People this account manages (lib/managed-people.ts; ADR 0022): a child, or
 * somebody else the adult has authority for, who needs no login of their
 * own. Add, change and stop managing; nothing but a name, a birth year if an
 * activity needs one, and the adult's declared relationship and authority.
 * Another adult's request to become a guardian waits here for this
 * guardian's answer, and recent changes to who acts for each person can be
 * reported as a mistake (lib/guardian-requests.ts).
 */
export default function ManagedPeople() {
  const t = useT();
  const [people, setPeople] = useState<ManagedPerson[] | null>(null);
  // The participant this account is the own login of, if any (lib/participants.ts).
  const [own, setOwn] = useState<{ id: number; displayName: string } | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codeForm, setCodeForm] = useState(EMPTY_CODE);
  const [requests, setRequests] = useState<AccountRequests | null>(null);

  const load = useCallback(() => {
    fetch("/api/my/people?archived=1", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setPeople(data.people);
        setOwn(data.own ?? null);
        setRequests(data.requests ?? null);
      })
      .catch(() => {});
  }, []);

  /** A code for another guardian, or for their own login: shown once (lib/participants.ts). */
  async function invite(p: ManagedPerson, purpose: "guardian" | "link" | "claim") {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/my/people/invites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id, purpose }) });
      const data = await res.json();
      if (!res.ok) throw new Error(explainGuard(t, data));
      const date = new Date(data.expiresAt).toLocaleDateString();
      setNotice(
        purpose === "guardian"
          ? t("ptc.invite.toGuardian", { code: data.code, date })
          : purpose === "claim"
            ? t("gw5.claim.code", { name: p.displayName, code: data.code, date })
            : t("ptc.invite.toLogin", { name: p.displayName, code: data.code, date })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("guard.failed"));
    } finally {
      setBusy(false);
    }
  }

  /** Stop being their guardian for good: nothing new from this account; what it made stays. */
  async function end(p: ManagedPerson) {
    if (!window.confirm(t("ptc.endConfirm", { name: p.displayName }))) return;
    const reason = window.prompt(t("ptc.endReason")) ?? "";
    await send("PATCH", { id: p.id, end: true, reason });
  }

  async function accept(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/my/people/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: codeForm.code, relationship: codeForm.relationship, ...(codeForm.authority ? { authority: true } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(explainGuard(t, data));
      setNotice(
        data.as === "pending"
          ? t("gv.accept.pending", { name: data.person.displayName })
          : data.as === "guardian"
            ? t("ptc.accept.doneGuardian", { name: data.person.displayName })
            : data.as === "claimed"
              ? t("gw5.accept.claimed", { name: data.person.displayName })
              : t("ptc.accept.doneLinked", { name: data.person.displayName })
      );
      setCodeForm(EMPTY_CODE);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("guard.failed"));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => load(), [load]);

  /** An existing guardian's answer to another adult's request (lib/guardian-requests.ts answerRequest). */
  async function answer(id: number, name: string, agree: boolean) {
    const reason = agree ? undefined : window.prompt(t("gv.refuseReason"));
    if (reason === null) return;
    await post("/api/my/people/requests", { id, agree, ...(reason ? { reason } : {}) }, agree ? t("gv.agreed", { name }) : t("gv.refused"));
  }

  /** Report a change to who acts for somebody as a mistake: flagged for a manager (lib/guardian-requests.ts reportMistake). */
  async function report(participantId: number, guardianshipId: number) {
    const note = window.prompt(t("gv.change.reportPrompt"));
    if (note === null) return;
    await post("/api/my/people/report", { id: participantId, guardianshipId, note }, t("gv.change.reportDone"));
  }

  async function post(url: string, body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(explainGuard(t, data));
      setNotice(done);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("guard.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function send(method: "POST" | "PATCH", body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/my/people", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(explainGuard(t, data));
      setForm(EMPTY);
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("guard.failed"));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const fields = {
      displayName: form.displayName,
      birthYear: form.birthYear.trim() === "" ? null : Number(form.birthYear),
      relationship: form.relationship,
      ...(form.authority ? { authority: true } : {}),
    };
    void (editing === null ? send("POST", fields) : send("PATCH", { id: editing, ...fields }));
  }

  if (people === null) return null;
  const live = people.filter((p) => !p.archivedAt);
  const archived = people.filter((p) => p.archivedAt);
  const field = "mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm";
  return (
    <section id="people" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <h2 className="text-lg font-bold">{t("guard.title")}</h2>
        <p className="mt-1 text-sm text-slate-600">{t("guard.intro")}</p>
      </div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>}
      {own && <p className="text-sm text-slate-600">{t("ptc.own", { name: own.displayName })}</p>}
      {requests && requests.toAnswer.length > 0 && (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="font-medium">{t("gv.toAnswer.title")}</p>
          {requests.toAnswer.map((r) => (
            <div key={r.id} className="space-y-1">
              <p>
                {t("gv.toAnswer.line", { proposed: r.proposedName, name: r.displayName, relationship: t(`guard.rel.${r.relationship}`) })}{" "}
                {r.venueName ? t("gv.toAnswer.by", { by: r.startedBy, venue: r.venueName }) : ""}
              </p>
              <p className="text-xs text-slate-600">{t("gv.toAnswer.note", { name: r.displayName })}</p>
              <div className="flex gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void answer(r.id, r.displayName, true)}
                  className="rounded-lg bg-teal-600 px-3 py-1 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {t("gv.agree")}
                </button>
                <button type="button" disabled={busy} onClick={() => void answer(r.id, r.displayName, false)} className="text-sm text-red-700 underline">
                  {t("gv.refuse")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {requests?.pending.map((r) => (
        <p key={`pending-${r.id}`} className="text-sm text-slate-600">
          {t("gv.pending.line", { name: r.displayName })}
        </p>
      ))}
      {requests?.paused.map((r, i) => (
        <p key={`paused-${i}`} className="text-sm text-amber-800">
          {t("gv.paused.line", { name: r.displayName })}
        </p>
      ))}
      {live.length === 0 && <p className="text-sm text-slate-500">{t("guard.none")}</p>}
      <ul className="divide-y divide-slate-100 text-sm">
        {live.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <span className="font-medium">{p.displayName}</span>
              {p.birthYear ? ` · ${t("guard.born", { year: p.birthYear })}` : ""} · {t(`guard.rel.${p.relationship}`)}
              {p.otherGuardians > 0 ? ` · ${t("ptc.others", { n: p.otherGuardians })}` : ""}
              {p.linked ? ` · ${t("ptc.linked")}` : ""}
              {requests?.changes
                .filter((c) => c.participantId === p.id)
                .map((c) => (
                  <span key={`${c.guardianshipId}-${c.kind}`} className="mt-0.5 block text-xs text-slate-500">
                    {t(c.kind === "added" ? "gv.change.added" : "gv.change.ended", { date: new Date(c.at).toLocaleDateString() })}{" "}
                    {c.kind === "added" &&
                      (c.reported ? (
                        t("gv.change.reported")
                      ) : (
                        <button type="button" disabled={busy} className="text-red-700 underline" onClick={() => void report(p.id, c.guardianshipId)}>
                          {t("gv.change.report")}
                        </button>
                      ))}
                  </span>
                ))}
            </span>
            <span className="flex flex-wrap gap-3 text-xs">
              <button
                type="button"
                className="font-medium text-teal-700 underline"
                onClick={() => {
                  setEditing(p.id);
                  setForm({ displayName: p.displayName, birthYear: p.birthYear ? String(p.birthYear) : "", relationship: p.relationship, authority: false });
                }}
              >
                {t("guard.edit")}
              </button>
              <button
                type="button"
                disabled={busy}
                className="text-slate-600 underline"
                onClick={() => window.confirm(t("guard.archiveConfirm", { name: p.displayName })) && void send("PATCH", { id: p.id, archived: true })}
              >
                {t("guard.archive")}
              </button>
              <button type="button" disabled={busy} className="text-teal-700 underline" onClick={() => void invite(p, "guardian")}>
                {t("ptc.invite.guardian")}
              </button>
              {!p.linked && (
                <button type="button" disabled={busy} className="text-teal-700 underline" onClick={() => void invite(p, "link")}>
                  {t("ptc.invite.link")}
                </button>
              )}
              {(p.recordedGuardians ?? 0) > 0 && (
                <button type="button" disabled={busy} className="text-teal-700 underline" onClick={() => void invite(p, "claim")}>
                  {t("gw5.claim.give")}
                </button>
              )}
              <button type="button" disabled={busy} className="text-red-700 underline" onClick={() => void end(p)}>
                {t("ptc.end")}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="space-y-2 rounded-lg border border-slate-100 bg-slate-50 p-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-xs text-slate-600">
            {t("guard.name")}
            <input required maxLength={40} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} className={field} />
          </label>
          <label className="text-xs text-slate-600">
            {t("guard.birthYear")}
            <input inputMode="numeric" maxLength={4} value={form.birthYear} onChange={(e) => setForm({ ...form, birthYear: e.target.value })} className={field} />
          </label>
          <label className="text-xs text-slate-600">
            {t("guard.relationship")}
            <select value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value as Relationship })} className={field}>
              {RELATIONSHIPS.map((r) => (
                <option key={r} value={r}>
                  {t(`guard.rel.${r}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.authority}
            onChange={(e) => setForm({ ...form, authority: e.target.checked })}
            className="mt-1"
            required={editing === null || people.find((p) => p.id === editing)?.relationship !== form.relationship}
          />
          {t("guard.authorityAdd")}
        </label>
        <p className="text-xs text-slate-500">
          {t("guard.declaredNote")} {t("guard.notDiscoverable")}
        </p>
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
            {editing === null ? t("guard.add") : t("guard.save")}
          </button>
          {editing !== null && (
            <button
              type="button"
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              onClick={() => {
                setEditing(null);
                setForm(EMPTY);
              }}
            >
              {t("guard.cancel")}
            </button>
          )}
        </div>
      </form>
      <form onSubmit={accept} className="space-y-2 rounded-lg border border-slate-100 p-3">
        <p className="text-sm font-medium">{t("ptc.accept.title")}</p>
        <p className="text-xs text-slate-500">{t("gv.accept.intro")}</p>
        <p className="text-xs text-slate-500">{t("gw5.accept.claimHint")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-slate-600">
            {t("ptc.accept.code")}
            <input required maxLength={12} autoComplete="off" value={codeForm.code} onChange={(e) => setCodeForm({ ...codeForm, code: e.target.value })} className={field} />
          </label>
          <label className="text-xs text-slate-600">
            {t("ptc.accept.relationship")}
            <select value={codeForm.relationship} onChange={(e) => setCodeForm({ ...codeForm, relationship: e.target.value as Relationship })} className={field}>
              {RELATIONSHIPS.map((r) => (
                <option key={r} value={r}>
                  {t(`guard.rel.${r}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={codeForm.authority} onChange={(e) => setCodeForm({ ...codeForm, authority: e.target.checked })} className="mt-1" />
          {t("ptc.accept.authority")}
        </label>
        <button type="submit" disabled={busy} className="rounded-lg border border-teal-600 px-3 py-1.5 text-sm font-semibold text-teal-700 disabled:opacity-50">
          {t("ptc.accept.submit")}
        </button>
      </form>
      {archived.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-medium text-slate-500">{t("guard.archivedTitle")}</summary>
          <ul className="mt-1 space-y-1">
            {archived.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 text-slate-500">
                {p.displayName}
                <button type="button" disabled={busy} className="text-xs text-teal-700 underline" onClick={() => void send("PATCH", { id: p.id, archived: false })}>
                  {t("guard.restore")}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
