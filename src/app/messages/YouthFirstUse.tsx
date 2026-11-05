"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import type { MyYouthGroup } from "@/lib/youth-messages";

/**
 * The first screen for an account that has not said it is 18 or over, and is in a supervised youth group (docs/features/player-messages.md
 * #supervised-youth-groups; ADR 0044): short, plain, and it says who can see the messages. For each such group, where the three consents
 * stand (the group is marked, a guardian has switched it on, the child has), the child's own opt-in, and a way into the conversation once
 * all three are on. There is no way to start a private conversation from here, and none anywhere.
 */
export function YouthFirstUse({ onOpen }: { onOpen: (groupId: number) => void }) {
  const t = useT();
  const [data, setData] = useState<{ linked: boolean; groups: MyYouthGroup[]; enabled?: boolean } | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/messages/youth", { cache: "no-store" });
    if (res.ok) setData(await readJson(res));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function optIn(groupId: number, on: boolean) {
    setError(null);
    const res = await fetch("/api/messages/youth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupId, on }) });
    const body = await readJson(res).catch(() => null);
    if (!res.ok) return setError(translateError(t, body));
    setData(body);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold">{t("pmsg.title")}</h1>
      <section aria-labelledby="pmy-first" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
        <h2 id="pmy-first" className="text-lg font-semibold text-slate-900">
          {t("pmy.first.title")}
        </h2>
        <p>{t("pmy.first.what")}</p>
        <p>{t("pmy.first.who")}</p>
        <p>{t("pmy.first.rules")}</p>
        <p>{t("pmy.first.safe")}</p>
        {data && data.enabled === false && (
          <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-amber-900" data-testid="youth-off">
            {t("err.YG_OFF")}
          </p>
        )}
        {data && data.enabled !== false && !data.linked && <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900">{t("pmy.first.needGuardian")}</p>}
      </section>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {data && data.groups.length === 0 && <p className="text-sm text-slate-600">{t("pmy.first.none")}</p>}
      {data && data.groups.length > 0 && (
        <section aria-labelledby="pmy-groups" className="space-y-2">
          <h2 id="pmy-groups" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            {t("pmy.first.groups")}
          </h2>
          <ul className="space-y-2">
            {data.groups.map((g) => (
              <li key={g.groupId} className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 text-sm">
                <p className="font-medium text-slate-900">{g.name}</p>
                {g.supervisors.length > 0 && <p className="text-slate-600">{t("pmy.first.supervisedBy", { names: g.supervisors.map((s) => s.name).join(", ") })}</p>}
                <p className="text-slate-600">{g.guardianOn ? t("pmy.first.guardianOn") : t("pmy.first.guardianOff")}</p>
                {g.active && <p className="text-emerald-700">{t("pmy.first.active")}</p>}
                {!g.optedIn && data.linked && (
                  <>
                    <label className="flex min-h-6 items-center gap-2 font-medium text-slate-900">
                      <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="h-5 w-5" />
                      {t("pmy.first.understood")}
                    </label>
                    <button onClick={() => void optIn(g.groupId, true)} disabled={!understood} className="min-h-10 rounded-md bg-teal-600 px-4 py-2 font-semibold text-white disabled:opacity-50">
                      {t("pmy.first.optIn")}
                    </button>
                  </>
                )}
                {g.optedIn && (
                  <button onClick={() => void optIn(g.groupId, false)} className="min-h-9 rounded-md px-1 text-slate-600 underline hover:text-teal-700">
                    {t("pmy.first.optOut")}
                  </button>
                )}
                {g.active && (
                  <button onClick={() => onOpen(g.groupId)} className="min-h-10 rounded-md border border-teal-600 px-4 py-2 font-semibold text-teal-700">
                    {t("pmy.first.open")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
