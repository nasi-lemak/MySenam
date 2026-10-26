"use client";

import { useCallback, useEffect, useState } from "react";
import type { ManagedPerson, Relationship } from "@/lib/managed-people";
import { hasPhrase, type Phrase, type T } from "@/lib/i18n";
import { useT } from "@/components/Language";

const RELATIONSHIPS: Relationship[] = ["parent", "guardian", "other"];

/** A refusal about somebody managed, in the customer's language: by its code where it has one. */
export function explainGuard(t: T, body: { error?: string; code?: string } | null | undefined): string {
  const key = body?.code ? `guard.err.${body.code}` : "";
  if (key && hasPhrase(key)) return t(key as Phrase);
  return body?.error || t("guard.failed");
}

const EMPTY = { displayName: "", birthYear: "", relationship: "parent" as Relationship, authority: false };

/**
 * People this account manages (lib/managed-people.ts; ADR 0022): a child, or
 * somebody else the adult has authority for, who needs no login of their
 * own. Add, change and stop managing; nothing but a name, a birth year if an
 * activity needs one, and the adult's declared relationship and authority.
 */
export default function ManagedPeople() {
  const t = useT();
  const [people, setPeople] = useState<ManagedPerson[] | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/my/people?archived=1", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setPeople(data.people))
      .catch(() => {});
  }, []);
  useEffect(() => load(), [load]);

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
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <h2 className="text-lg font-bold">{t("guard.title")}</h2>
        <p className="mt-1 text-sm text-slate-600">{t("guard.intro")}</p>
      </div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {live.length === 0 && <p className="text-sm text-slate-500">{t("guard.none")}</p>}
      <ul className="divide-y divide-slate-100 text-sm">
        {live.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <span className="font-medium">{p.displayName}</span>
              {p.birthYear ? ` · ${t("guard.born", { year: p.birthYear })}` : ""} · {t(`guard.rel.${p.relationship}`)}
            </span>
            <span className="flex gap-3 text-xs">
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
