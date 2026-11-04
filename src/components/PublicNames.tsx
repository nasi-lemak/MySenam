"use client";

import { useCallback, useEffect, useState } from "react";
import { readJson } from "@/lib/read-response";
import { translateError } from "@/lib/i18n";
import { useT } from "@/components/Language";
import { shortDate } from "@/lib/region";
import type { PublicNames } from "@/lib/public-name-consents";

/**
 * A guardian's page for one child: what the public sees of their name (first name and initial), and the one exception, which only
 * this guardian can make, for one event or all the child's entries at one venue (lib/public-name-consents.ts). Plain words on what
 * becomes public and that it can be withdrawn; nothing is on until the box is ticked and the button pressed.
 */
export default function PublicNamesPanel({ person }: { person: { id: number; displayName: string } }) {
  const t = useT();
  const [data, setData] = useState<PublicNames | null>(null);
  const [pick, setPick] = useState("");
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/my/people/public-name?id=${person.id}`, { cache: "no-store" });
    if (!res.ok) return;
    const body = await readJson(res);
    if (Array.isArray(body?.choices) && Array.isArray(body?.consents) && Array.isArray(body?.venues)) setData(body);
  }, [person.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/my/people/public-name", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await readJson(res);
      if (!res.ok) throw new Error(translateError(t, out) || out.error);
      setNotice(done);
      setPick("");
      setSure(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "");
    } finally {
      setBusy(false);
    }
  }

  function allow(e: React.FormEvent) {
    e.preventDefault();
    const [kind, id] = pick.split(":");
    void send(
      { action: "authorise", id: person.id, confirm: sure, locale: t.locale, ...(kind === "venue" ? { scope: "venue", venueId: Number(id) } : { scope: "event", kind, eventId: Number(id) }) },
      t("pn1.done")
    );
  }

  if (!data) return null;
  const months = data.months;
  const nothing = data.choices.length === 0 && data.consents.length === 0;
  return (
    <details className="mt-1 rounded-lg border border-slate-100 bg-slate-50 p-2 text-xs">
      <summary className="cursor-pointer font-medium text-teal-700">
        {t("pn1.open")}
        <span className="sr-only"> — {person.displayName}</span>
      </summary>
      <div className="mt-2 space-y-2 text-slate-600">
        <p>{t("pn1.intro")}</p>
        <p>{t("pn1.rules", { months, name: person.displayName })}</p>
        {error && (
          <p role="alert" className="rounded border border-red-200 bg-red-50 px-2 py-1 text-red-700">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-800">
            {notice}
          </p>
        )}
        {data.consents.length > 0 && (
          <div>
            <p className="font-medium text-slate-700">{t("pn1.inForce")}</p>
            <ul className="mt-1 space-y-1">
              {data.consents.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {c.scope === "event"
                      ? t("pn1.inForce.event", { event: c.eventName ?? "", venue: c.venueName })
                      : t("pn1.inForce.venue", { venue: c.venueName, date: shortDate(c.expiresAt.slice(0, 10), t.locale) })}
                    {!c.byYou && ` (${t("pn1.byOther")})`}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    className="text-red-700 underline"
                    aria-label={`${t("pn1.withdraw")}: ${c.scope === "event" ? (c.eventName ?? "") : c.venueName}`}
                    onClick={() => void send({ action: "withdraw", consentId: c.id }, t("pn1.withdrawn"))}
                  >
                    {t("pn1.withdraw")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {nothing ? (
          <p>{t("pn1.none", { name: person.displayName })}</p>
        ) : (
          data.choices.length > 0 && (
            <form onSubmit={allow} className="space-y-2">
              <label className="block text-slate-600">
                {t("pn1.pick")}
                <select value={pick} onChange={(e) => setPick(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm" name={`pn-${person.id}`}>
                  <option value="" />
                  {data.choices.map((c) => (
                    <option key={`${c.kind}:${c.id}`} value={`${c.kind}:${c.id}`}>
                      {t(`pn1.choice.${c.kind}`, { name: c.name, venue: c.venueName, date: c.until ? shortDate(c.until, t.locale) : "" })}
                    </option>
                  ))}
                  {data.venues.map((v) => (
                    <option key={`venue:${v.id}`} value={`venue:${v.id}`}>
                      {t("pn1.choice.venue", { child: person.displayName, venue: v.name, months })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} className="mt-1" />
                {t("pn1.confirm", { child: person.displayName })}
              </label>
              <button type="submit" disabled={busy || !pick || !sure} className="rounded-lg border border-teal-600 px-3 py-1.5 text-sm font-semibold text-teal-700 disabled:opacity-50">
                {t("pn1.allow")}
              </button>
            </form>
          )
        )}
      </div>
    </details>
  );
}
