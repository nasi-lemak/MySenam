"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { Storefront } from "@/lib/storefront";
import type { ManagedVenue } from "./shared";
import { useStaffT } from "./StaffLanguage";

const EMPTY = { hostname: "", name: "", tagline: "", accentColor: "", logoUrl: "", venueIds: [] as number[] };

/**
 * A venue's own website on the marketplace: abc.com showing ABC's venues
 * under ABC's name and colour. The domain has to point at this server too —
 * the panel says how — and until it does, saving one changes nothing anybody
 * can see.
 */
export function StorefrontsPanel({ venues }: { venues: ManagedVenue[] }) {
  const t = useStaffT();
  const [storefronts, setStorefronts] = useState<Storefront[] | null>(null);
  const [editing, setEditing] = useState<(typeof EMPTY & { id?: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/storefronts", { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("sf.loadFailed")));
      setStorefronts(data.storefronts);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sf.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/storefronts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("sf.saveFailed")));
      setNotice(t("sf.saved", { host: data.storefront.hostname }));
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sf.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: Storefront) {
    if (!window.confirm(t("sf.removeConfirm", { host: s.hostname }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/storefronts?id=${s.id}`, { method: "DELETE" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("sf.removeFailed")));
      setNotice(t("sf.removed", { host: s.hostname }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sf.removeFailed"));
    } finally {
      setBusy(false);
    }
  }

  const input =
    "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  const nameOf = (id: number) => venues.find((v) => v.id === id)?.name ?? `#${id}`;

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">{t("sf.title")}</h2>
        {!editing && (
          <button
            onClick={() => setEditing({ ...EMPTY })}
            className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700"
          >
            {t("sf.add")}
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {t("sf.intro")}
      </p>
      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-3 text-sm font-medium text-emerald-700">{notice}</p>}

      {editing && (
        <form onSubmit={save} className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-slate-700">
              {t("sf.domain")}
              <input
                required
                value={editing.hostname}
                onChange={(e) => setEditing({ ...editing, hostname: e.target.value })}
                placeholder="abcbadminton.com"
                className={`${input} font-mono`}
              />
            </label>
            <label className="text-sm font-medium text-slate-700">
              {t("sf.nameShown")}
              <input
                required
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder={t("sf.nameExample")}
                className={input}
              />
            </label>
            <label className="text-sm font-medium text-slate-700 sm:col-span-2">
              {t("sf.tagline")}
              <input
                value={editing.tagline}
                onChange={(e) => setEditing({ ...editing, tagline: e.target.value })}
                placeholder={t("sf.taglineExample")}
                className={input}
              />
            </label>
            <label className="text-sm font-medium text-slate-700">
              {t("sf.colour")}
              <div className="mt-1 flex gap-2">
                <input
                  type="color"
                  value={editing.accentColor || "#0d9488"}
                  onChange={(e) => setEditing({ ...editing, accentColor: e.target.value })}
                  aria-label={t("sf.pickColour")}
                  className="h-9 w-12 rounded border border-slate-300"
                />
                <input
                  value={editing.accentColor}
                  onChange={(e) => setEditing({ ...editing, accentColor: e.target.value })}
                  placeholder="#1d4ed8"
                  className={`${input} mt-0 font-mono`}
                />
              </div>
            </label>
            <label className="text-sm font-medium text-slate-700">
              {t("sf.logo")}
              <input
                value={editing.logoUrl}
                onChange={(e) => setEditing({ ...editing, logoUrl: e.target.value })}
                placeholder="https://…/logo.png"
                className={input}
              />
            </label>
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">{t("sf.venues")}</legend>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {venues.map((v) => (
                <label key={v.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editing.venueIds.includes(v.id)}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        venueIds: e.target.checked
                          ? [...editing.venueIds, v.id]
                          : editing.venueIds.filter((id) => id !== v.id),
                      })
                    }
                    className="accent-teal-600"
                  />
                  {v.name}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {t("c.save")}
            </button>
            <button type="button" onClick={() => setEditing(null)} className="px-3 text-sm text-slate-500">
              {t("c.cancel")}
            </button>
          </div>
          <p className="text-xs text-slate-500">
            {t("sf.dnsHelp")}
          </p>
        </form>
      )}

      {storefronts && storefronts.length > 0 && (
        <ul className="mt-3 space-y-2">
          {storefronts.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3"
            >
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="h-6 w-6 shrink-0 rounded-full border border-slate-200"
                  style={{ backgroundColor: s.accentColor ?? "#0d9488" }}
                />
                <div>
                  <a
                    href={`https://${s.hostname}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-sm font-semibold hover:underline"
                  >
                    {s.hostname}
                  </a>
                  <div className="text-sm text-slate-600">
                    {s.name} · {s.venueIds.map(nameOf).join(", ")}
                  </div>
                </div>
              </div>
              <div className="flex gap-3 text-xs font-semibold">
                <button
                  onClick={() =>
                    setEditing({
                      id: s.id,
                      hostname: s.hostname,
                      name: s.name,
                      tagline: s.tagline ?? "",
                      accentColor: s.accentColor ?? "",
                      logoUrl: s.logoUrl ?? "",
                      venueIds: s.venueIds,
                    })
                  }
                  className="text-teal-700 hover:underline"
                >
                  {t("c.change")}
                </button>
                <button disabled={busy} onClick={() => remove(s)} className="text-red-600 hover:underline">
                  {t("c.remove")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
