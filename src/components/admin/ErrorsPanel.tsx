"use client";

import { useEffect, useState } from "react";
import type { ErrorGroup } from "@/lib/error-log";
import { localTime } from "./shared";
import { useStaffT } from "./StaffLanguage";

/**
 * Errors by kind, for the platform owner: what failed, how often, where last
 * and its stack, from the server and from customers' browsers. Marking one
 * fixed takes it off until it happens again.
 */
export function ErrorsPanel() {
  const t = useStaffT();
  const [errors, setErrors] = useState<ErrorGroup[] | null>(null);
  const [sentry, setSentry] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    void fetch("/api/admin/errors", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { errors: ErrorGroup[]; sentry: boolean } | null) => {
        setErrors(d?.errors ?? null);
        setSentry(d?.sentry ?? false);
      })
      .catch(() => setErrors(null));
  }, []);

  async function fixed(id: number) {
    const res = await fetch("/api/admin/errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) setErrors((await res.json()).errors);
  }

  if (!errors || errors.length === 0) return null;
  return (
    <details className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
      <summary className="cursor-pointer font-semibold">
        🐞 {t.plural("errs.summary", errors.length, { total: errors.reduce((n, e) => n + e.count, 0) })}
        {sentry && <span className="font-normal text-amber-800"> · {t("errs.sentry")}</span>}
      </summary>
      <ul className="mt-2 space-y-2">
        {errors.map((e) => (
          <li key={e.id} className="rounded-lg bg-white/80 px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <button onClick={() => setOpen(open === e.id ? null : e.id)} className="text-left font-semibold">
                <span className="mr-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium">{e.source}</span>
                {e.name}: {e.message}
              </button>
              <button onClick={() => fixed(e.id)} className="text-xs font-semibold text-amber-900 underline">
                {t("errs.fixed")}
              </button>
            </div>
            <p className="mt-0.5 text-xs text-amber-800">
              {t("errs.countLast", { n: e.count, date: e.lastAt.slice(0, 10), time: localTime(e.lastAt) })}
              {e.path && ` · ${e.method ? `${e.method} ` : ""}${e.path}`} · {t("errs.first", { date: e.firstAt.slice(0, 10) })}
            </p>
            {open === e.id && e.stack && (
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-slate-700">{e.stack}</pre>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
