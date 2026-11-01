"use client";

import { useCallback, useEffect, useState } from "react";
import { readJson } from "@/lib/read-response";
import type { StaffPhrase } from "@/lib/staff-i18n";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/**
 * AI assistants connected by signing in (docs/integrations/mcp.md#revoking):
 * the account's own, and for a manager also those of anybody at the venues
 * they manage, each with the name the application gave (not verified), the
 * venue, whose it is, what it may do and when it was last used, and Revoke.
 * Shown to every member of staff, beside their own sign-in settings.
 */

type Scope = "venue:read" | "venue:book" | "venue:configure";
interface Assistant {
  id: number;
  clientName: string;
  venueId: number;
  venueName: string;
  personName: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt: string | null;
  mine: boolean;
}

const SHORT: Record<Scope, StaffPhrase> = { "venue:read": "oa.short.read", "venue:book": "oa.short.book", "venue:configure": "oa.short.configure" };

export function AssistantsPanel() {
  const t = useStaffT();
  const clock = useStaffClock();
  const [list, setList] = useState<Assistant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/assistants", { cache: "no-store" });
    const body = await readJson(res);
    if (!res.ok) return setError(t.err(body, t("c.failed")));
    setList(body.assistants as Assistant[]);
  }, [t]);

  useEffect(() => {
    void load().catch(() => setError(t("c.failed")));
  }, [load, t]);

  async function revoke(a: Assistant) {
    if (!window.confirm(t("oa.revokeConfirm", { client: a.clientName }))) return;
    setError(null);
    try {
      const res = await fetch("/api/admin/assistants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "revoke", id: a.id }) });
      const body = await readJson(res);
      if (!res.ok) return setError(t.err(body, t("c.failed")));
      setList(body.assistants as Assistant[]);
    } catch {
      setError(t("c.failed"));
    }
  }

  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm">
      <summary className="cursor-pointer font-medium text-slate-700">
        {t("oa.panel")}
        {list && list.length > 0 ? ` (${list.length})` : ""}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-slate-600">{t("oa.panelIntro")}</p>
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
        {list && list.length === 0 && <p className="text-slate-500">{t("oa.none")}</p>}
        {list && list.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {list.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
                <span>
                  <span className="font-medium">{t("oa.row", { client: a.clientName, venue: a.venueName, person: a.personName })}</span>
                  <span className="block text-xs text-slate-500">
                    {t("oa.mayShort", { what: a.scopes.map((s) => t(SHORT[s])).join(", ") })} · {t("oa.connected", { date: clock.day(a.createdAt, a.venueId) })} ·{" "}
                    {a.lastUsedAt ? t("int.lastUsed", { date: clock.when(a.lastUsedAt, a.venueId) }) : t("int.notUsedYet")}
                  </span>
                </span>
                <button type="button" onClick={() => void revoke(a)} className="min-h-8 rounded-md border border-red-200 px-3 text-red-700 hover:border-red-400">
                  {t("int.revoke")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
