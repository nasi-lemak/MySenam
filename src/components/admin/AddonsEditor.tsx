"use client";

import { readJson } from "@/lib/read-response";
import { sportsOf } from "@/lib/court-activities";
import { sportLabel } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import type { Addon } from "@/lib/addons";
import type { ManagedVenue } from "./shared";
import { money } from "@/lib/region";
import { useStaffT } from "./StaffLanguage";

const BLANK = { name: "", kind: "rental" as "rental" | "sale", price: "", stock: "", sport: "" };

/**
 * What customers can add when they book or enrol: rackets and bibs to hire,
 * shuttles and drinks to buy. Retired, never deleted, so old bookings still
 * say what they had.
 */
export function AddonsEditor({ venue }: { venue: ManagedVenue }) {
  const t = useStaffT();
  const [open, setOpen] = useState(false);
  const [addons, setAddons] = useState<Addon[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [f, setF] = useState(BLANK);
  const sports = sportsOf(venue.courts);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/addons?venueId=${venue.id}`, { cache: "no-store" });
    if (res.ok) setAddons((await readJson(res)).addons);
  }, [venue.id]);
  useEffect(() => {
    if (open && addons === null) void load();
  }, [open, addons, load]);

  async function send(url: string, method: string, body?: object) {
    setError(null);
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await readJson(res);
    if (!res.ok) {
      setError(t.err(out));
      return false;
    }
    setAddons(out.addons);
    return true;
  }

  const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
  const active = (addons ?? []).filter((a) => a.active).length;

  return (
    <div className="w-full border-t border-slate-100 pt-2 text-sm">
      <button onClick={() => setOpen(!open)} className="text-xs font-medium text-teal-700 underline">
        {open ? t("add.close") : active ? t("add.toggleCount", { n: active }) : t("add.toggleOptional")}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-slate-500">
            {t("add.intro")}
          </p>
          {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
          <ul className="space-y-1">
            {(addons ?? []).map((a) => (
              <li
                key={a.id}
                className={`flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-xs ${a.active ? "bg-slate-50" : "bg-slate-50 text-slate-400"}`}
              >
                <span className="flex-1">
                  {a.kind === "rental" ? "🎒" : "🛒"} <span className="font-medium">{a.name}</span> · {money(a.price)}
                  {" "}
                  {a.kind === "rental" ? (a.stock !== null ? t("add.toHireStock", { n: a.stock }) : t("add.toHire")) : t("add.toBuy")}
                  {a.sport && ` · ${t("add.sportOnly", { sport: sportLabel(t.customer, a.sport) })}`}
                  {!a.active && ` · ${t("add.retired")}`}
                </span>
                {a.active && (
                  <button
                    onClick={() => {
                      setEditing(a.id);
                      setF({ name: a.name, kind: a.kind, price: String(a.price), stock: a.stock === null ? "" : String(a.stock), sport: a.sport ?? "" });
                    }}
                    className="text-teal-700 underline"
                  >
                    {t("c.edit")}
                  </button>
                )}
                <button
                  onClick={() =>
                    a.active
                      ? send(`/api/admin/addons/${a.id}`, "DELETE")
                      : send(`/api/admin/addons/${a.id}`, "PATCH", { active: true })
                  }
                  className={a.active ? "text-red-700 underline" : "text-teal-700 underline"}
                >
                  {a.active ? t("add.retire") : t("add.bringBack")}
                </button>
              </li>
            ))}
          </ul>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const body = { ...f, venueId: venue.id };
              const ok = editing
                ? await send(`/api/admin/addons/${editing}`, "PATCH", body)
                : await send("/api/admin/addons", "POST", body);
              if (ok) {
                setEditing(null);
                setF(BLANK);
              }
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <label className="flex min-w-[10rem] flex-1 flex-col text-xs font-medium text-slate-500">
              {t("c.name")}
              <input required minLength={2} maxLength={60} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={input} placeholder={t("add.nameExample")} />
            </label>
            <label className="flex flex-col text-xs font-medium text-slate-500">
              {t("add.kind")}
              <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "rental" | "sale" })} className={input}>
                <option value="rental">{t("add.optHire")}</option>
                <option value="sale">{t("add.optBuy")}</option>
              </select>
            </label>
            <label className="flex flex-col text-xs font-medium text-slate-500">
              {t("add.price")}
              <input required type="number" min={0} max={1000} step={0.01} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} className={`w-24 ${input}`} />
            </label>
            {f.kind === "rental" && (
              <label className="flex flex-col text-xs font-medium text-slate-500">
                {t("add.stock")}
                <input type="number" min={1} max={500} value={f.stock} onChange={(e) => setF({ ...f, stock: e.target.value })} className={`w-28 ${input}`} placeholder={t("add.noLimit")} />
              </label>
            )}
            {sports.length > 1 && (
              <label className="flex flex-col text-xs font-medium text-slate-500">
                {t("add.with")}
                <select value={f.sport} onChange={(e) => setF({ ...f, sport: e.target.value })} className={input}>
                  <option value="">{t("add.anySport")}</option>
                  {sports.map((s) => (
                    <option key={s} value={s}>
                      {t("add.sportOnly", { sport: sportLabel(t.customer, s) })}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700">
              {editing ? t("add.saveChanges") : t("c.add")}
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setF(BLANK);
                }}
                className="text-xs text-slate-500 underline"
              >
                {t("c.cancel")}
              </button>
            )}
          </form>
        </div>
      )}
    </div>
  );
}
