"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";

/**
 * Change the password while signed in — or set one, for an account made with
 * Google. `endpoint` is `/api/my/password` for customers and
 * `/api/admin/auth/password` for staff. Closed until asked for.
 */
export function ChangePassword({ endpoint }: { endpoint: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [has, setHas] = useState<boolean | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open || has !== null) return;
    void fetch(endpoint, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { hasPassword?: boolean }) => setHas(d.hasPassword !== false))
      .catch(() => setHas(true));
  }, [open, has, endpoint]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current, next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("auth.failed"));
      setDone(true);
      setOpen(false);
      setHas(true);
      setCurrent("");
      setNext("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.failed"));
    } finally {
      setBusy(false);
    }
  }

  const inputClass = "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none";

  if (!open)
    return (
      <div className="space-y-1">
        <button
          onClick={() => {
            setOpen(true);
            setDone(false);
          }}
          className="inline-flex min-h-9 items-center rounded-md px-2 text-sm text-slate-500 underline hover:text-teal-700"
        >
          {t("reset.change")}
        </button>
        {done && <p role="status" className="px-2 text-sm text-teal-700">{t("reset.changed")}</p>}
      </div>
    );

  return (
    <form onSubmit={save} className="max-w-sm space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="font-semibold">{has === false ? t("reset.set") : t("reset.change")}</p>
      {has === false ? (
        <p className="text-sm text-slate-600">{t("reset.noPassword")}</p>
      ) : (
        <label className="block text-sm font-medium text-slate-700">
          {t("reset.current")}
          <input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={inputClass} />
        </label>
      )}
      <label className="block text-sm font-medium text-slate-700">
        {t("reset.newPassword")}
        <input
          type="password"
          required
          minLength={8}
          maxLength={200}
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder={t("auth.passwordHint")}
          className={inputClass}
        />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy || has === null} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
          {busy ? t("auth.working") : has === false ? t("reset.set") : t("reset.change")}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500 underline">
          {t("reset.cancel")}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
