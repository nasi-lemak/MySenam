"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { EntryCount, EntryOptions, EntryResource, OpenEntry } from "@/lib/entries";
import { COUNTER_METHODS, type CounterMethod } from "@/lib/types";
import { money } from "@/lib/region";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/**
 * Entry with no set time at the desk (lib/entries.ts;
 * docs/features/venue-operations.md#entry-with-no-set-time): how full each
 * resource taking entries is, finding a person by their number and what lets
 * them in (a membership, a pass or day pass, or a walk-in at the resource's
 * price), admitting them, and who is in now with a check-out for each. Shown
 * only at a venue with a resource taking entries.
 */

type Resource = EntryResource & { count: EntryCount };
interface Person {
  participantId: number | null;
  name: string;
  options: EntryOptions;
}

export function EntryDesk({ venues }: { venues: { id: number; name: string }[] }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [resources, setResources] = useState<Resource[]>([]);
  const [inNow, setInNow] = useState<OpenEntry[]>([]);
  const [courtId, setCourtId] = useState(0);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [people, setPeople] = useState<Person[] | null>(null);
  const [via, setVia] = useState<CounterMethod>("cash");
  const [waiver, setWaiver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const res = await fetch(`/api/admin/entries?venueId=${venueId}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await readJson(res);
      setResources(data.resources ?? []);
      setInNow(data.inNow ?? []);
      setCourtId((c) => ((data.resources ?? []).some((r: Resource) => r.courtId === c) ? c : (data.resources?.[0]?.courtId ?? 0)));
    } catch {
      // The last reading stays on screen.
    }
  }, [venueId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (resources.length === 0) return null;
  const resource = resources.find((r) => r.courtId === courtId) ?? resources[0];

  async function find(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/admin/entries?venueId=${venueId}&courtId=${resource.courtId}&phone=${encodeURIComponent(phone.trim())}`, { cache: "no-store" });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) return setError(t.err(data, t("nbk.desk.failed")));
    if (!name && data.knownName) setName(data.knownName);
    setPeople([
      { participantId: null, name: data.knownName ?? "", options: data.customer },
      ...(data.participants ?? []).map((p: { id: number; name: string; options: EntryOptions }) => ({ participantId: p.id, name: p.name, options: p.options })),
    ]);
  }

  async function admit(person: Person, by: { by: "membership" } | { by: "pass"; passId: number } | { by: "walk_in"; via: CounterMethod }) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId,
          courtId: resource.courtId,
          phone: phone.trim(),
          name: person.participantId === null ? name.trim() : person.name,
          participantId: person.participantId,
          agreeWaiver: waiver,
          ...by,
        }),
      });
      const data = await readJson(res).catch(() => ({}));
      if (!res.ok) throw new Error(t.err(data, t("nbk.desk.failed")));
      const a = data.admission;
      setNotice(
        [t("nbk.desk.admitted", { name: a.name, time: clock.time(a.stayUntil, venueId) }), a.receipt ? t("nbk.desk.receipt", { number: a.receipt.number }) : null]
          .filter(Boolean)
          .join(" ")
      );
      setPeople(null);
      setPhone("");
      setName("");
      setWaiver(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("nbk.desk.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function checkOut(entry: OpenEntry) {
    setError(null);
    const res = await fetch("/api/admin/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, entryId: entry.id, out: true }),
    });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) setError(t.err(data, t("nbk.desk.failed")));
    await load();
  }

  const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  const button = "min-h-6 rounded-md border border-teal-300 px-2 py-1 text-xs font-medium text-teal-800 hover:bg-teal-50 disabled:opacity-50";

  return (
    <section className="rounded-xl border border-teal-200 bg-teal-50/40 p-4" aria-labelledby="entry-desk-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="entry-desk-title" className="text-lg font-bold">
          {t("nbk.desk.title")}
        </h2>
        {venues.length > 1 && (
          <select value={venueId} onChange={(e) => setVenueId(Number(e.target.value))} aria-label={t("c.venue")} className={input}>
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-600">{t("nbk.desk.intro")}</p>
      <ul className="mt-2 space-y-1 text-sm">
        {resources.map((r) => (
          <li key={r.courtId}>
            {t("nbk.desk.count", { name: r.name, taken: r.count.entries + r.count.held, capacity: r.capacity, entries: r.count.entries, held: r.count.held })}
          </li>
        ))}
      </ul>

      <form onSubmit={find} className="mt-3 flex flex-wrap items-end gap-2">
        {resources.length > 1 && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("nbk.desk.where")}
            <select value={resource.courtId} onChange={(e) => { setCourtId(Number(e.target.value)); setPeople(null); }} className={`mt-1 ${input}`}>
              {resources.map((r) => (
                <option key={r.courtId} value={r.courtId}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("nbk.desk.phone")}
          <input type="tel" required value={phone} onChange={(e) => { setPhone(e.target.value); setPeople(null); }} className={`mt-1 ${input}`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("nbk.desk.name")}
          <input value={name} onChange={(e) => setName(e.target.value)} className={`mt-1 ${input}`} />
        </label>
        <button type="submit" className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">
          {t("nbk.desk.find")}
        </button>
      </form>

      {people && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <label className="flex items-center gap-1">
              {t("nbk.desk.via")}
              <select value={via} onChange={(e) => setVia(e.target.value as CounterMethod)} className="rounded border border-slate-300 px-1 py-0.5">
                {COUNTER_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`c.via.${m}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={waiver} onChange={(e) => setWaiver(e.target.checked)} />
              {t("nbk.desk.waiver")}
            </label>
          </div>
          {people.map((p) => {
            const o = p.options;
            const none = !o.membership && o.passes.length === 0 && o.walkIn === null;
            return (
              <div key={p.participantId ?? "customer"} className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-sm font-semibold">{p.participantId === null ? t("nbk.desk.customer") : t("nbk.desk.participant", { name: p.name })}</p>
                {o.alreadyIn ? (
                  <p className="mt-1 text-xs font-medium text-amber-700">{t("nbk.desk.alreadyIn")}</p>
                ) : none ? (
                  <p className="mt-1 text-xs text-slate-500">{t("nbk.desk.nothing")}</p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {o.membership && (
                      <button type="button" disabled={busy} onClick={() => void admit(p, { by: "membership" })} className={button}>
                        {t("nbk.desk.admit")}: {t("nbk.desk.membership", { code: o.membership.code, plan: o.membership.plan })}
                      </button>
                    )}
                    {o.passes.map((pass) => (
                      <button key={pass.id} type="button" disabled={busy} onClick={() => void admit(p, { by: "pass", passId: pass.id })} className={button}>
                        {t("nbk.desk.admit")}:{" "}
                        {pass.dayPass
                          ? pass.usedToday
                            ? t("nbk.desk.dayUsed", { code: pass.code, name: pass.name })
                            : t("nbk.desk.dayPass", { code: pass.code, name: pass.name })
                          : t("nbk.desk.pass", { code: pass.code, name: pass.name, n: pass.remaining })}
                      </button>
                    ))}
                    {o.walkIn !== null && (
                      <button type="button" disabled={busy} onClick={() => void admit(p, { by: "walk_in", via })} className={button}>
                        {t("nbk.desk.admit")}: {o.walkIn > 0 ? t("nbk.desk.walkIn", { price: money(o.walkIn) }) : t("nbk.desk.walkInFree")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {notice && <p className="mt-2 text-sm font-medium text-teal-800" role="status">{notice}</p>}
      {error && <p className="mt-2 text-sm font-medium text-red-700" role="alert">{error}</p>}

      <h3 className="mt-4 text-sm font-semibold">{t("nbk.desk.inNow")}</h3>
      {inNow.length === 0 ? (
        <p className="text-xs text-slate-500">{t("nbk.desk.noneIn")}</p>
      ) : (
        <ul className="mt-1 divide-y divide-slate-100 text-sm">
          {inNow.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span>
                <span className="font-medium">{e.name}</span>
                <span className="ml-2 text-xs text-slate-500">
                  {e.courtName} · {t(`nbk.desk.by.${e.admittedBy}`)}
                  {e.channel === "self" ? ` · ${t("nbk.desk.self")}` : ""} · {t("nbk.desk.until", { time: clock.time(e.stayUntil, venueId) })}
                </span>
              </span>
              <button type="button" onClick={() => void checkOut(e)} className={button}>
                {t("nbk.desk.checkOut")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {resource.selfCheckIn && <p className="mt-3 text-xs text-slate-500">{t("nbk.desk.selfCode", { path: `/checkin/entry/${resource.courtId}` })}</p>}
    </section>
  );
}
