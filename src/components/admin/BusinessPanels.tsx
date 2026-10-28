"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { Admin } from "@/lib/admin-auth";
import type { MapPoint } from "@/components/PinMap";
import PinPicker, { type PinPickerText } from "@/components/PinPicker";
import type { StaffT } from "@/lib/staff-i18n";
import type { ManagedVenue } from "./shared";
import { useStaffT } from "./StaffLanguage";

const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

const pinText = (t: StaffT): PinPickerText => ({
  label: t("biz.pin.label"),
  hint: t("biz.pin.hint"),
  find: t("biz.pin.find"),
  useLocation: t("biz.pin.useLocation"),
  looking: t("biz.pin.looking"),
  found: t("biz.pin.found"),
  notFound: t("biz.pin.notFound"),
  pinned: t("biz.pin.pinned"),
  locationFailed: t("biz.pin.locationFailed"),
});

interface BranchRequest {
  id: number;
  businessName: string;
  area: string;
  status: "draft" | "pending" | "approved" | "rejected";
  reason: string | null;
  createdAt: string;
}

/**
 * A business manager adding another branch. It is theirs to set up at once,
 * as a draft, and goes live like the first one did: sent from its banner on
 * the dashboard, and approved by the platform owner — or on its own, where
 * the install allows that and its pin and address agree. It may start from
 * one of the business's branches' set-up (lib/branch-copy.ts).
 */
export function BranchRequestPanel({
  businessName,
  branches = [],
  onChange,
}: {
  businessName: string;
  /** The business's branches this manager sees, to start a new one from. */
  branches?: { id: number; name: string }[];
  onChange: () => void;
}) {
  const t = useStaffT();
  const [requests, setRequests] = useState<BranchRequest[]>([]);
  const [form, setForm] = useState({ name: "", area: "", address: "", phone: "", message: "" });
  const [copyFrom, setCopyFrom] = useState("");
  const [pin, setPin] = useState<MapPoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/branches", { cache: "no-store" });
    if (res.ok) setRequests((await readJson(res)).requests);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!pin) return setError(t("biz.dropPin"));
    const name = form.name.trim();
    const res = await fetch("/api/admin/branches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, ...pin, ...(copyFrom ? { copyFrom: Number(copyFrom) } : {}) }),
    });
    const data = await readJson(res);
    if (!res.ok) return setError(t.err(data, t("biz.sendFailed")));
    const copied = data.copied as { courts: number; skippedCourts: string[] } | null;
    const from = branches.find((b) => String(b.id) === copyFrom)?.name ?? "";
    setNotice(
      copied
        ? [t.plural("r9c.copy.done", copied.courts, { name, from }), copied.skippedCourts.length ? t("r9c.copy.skipped", { from, courts: copied.skippedCourts.join(", ") }) : ""]
            .filter(Boolean)
            .join(" ")
        : t("biz.addedDraft", { name })
    );
    setForm({ name: "", area: "", address: "", phone: "", message: "" });
    setCopyFrom("");
    setPin(null);
    await load();
    onChange();
  }

  return (
    <section>
      <h2 className="text-lg font-bold">{t("biz.addBranch")}</h2>
      <p className="mt-1 text-sm text-slate-500">{t("biz.addBranchIntro", { business: businessName })}</p>
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-4">
        <input required minLength={2} placeholder={t("biz.branchName")} aria-label={t("biz.branchName")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`w-52 ${input}`} />
        <input required minLength={2} placeholder={t("biz.area")} aria-label={t("biz.area")} value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} className={`w-40 ${input}`} />
        <input required minLength={5} placeholder={t("biz.address")} aria-label={t("biz.address")} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={`w-64 ${input}`} />
        <input required placeholder={t("c.phone")} aria-label={t("c.phone")} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={`w-40 ${input}`} />
        <input placeholder={t("biz.anything")} aria-label={t("biz.anything")} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} className={`min-w-0 flex-1 ${input}`} />
        <div className="w-full">
          <PinPicker
            query={[form.address, form.area].filter((v) => v.trim()).join(", ")}
            pin={pin}
            onPin={setPin}
            text={pinText(t)}
          />
        </div>
        {branches.length > 0 && (
          <div className="w-full">
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{t("r9c.copy.label")}</span>
              <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} className={input}>
                <option value="">{t("r9c.copy.none")}</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {t("r9c.copy.from", { name: b.name })}
                  </option>
                ))}
              </select>
            </label>
            {copyFrom && <p className="mt-1 text-xs text-slate-500">{t("r9c.copy.hint")}</p>}
          </div>
        )}
        <button className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">{t("biz.addThisBranch")}</button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {notice && <p className="mt-2 text-sm text-emerald-700">{notice}</p>}
      {requests.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {requests.map((r) => (
            <li key={r.id}>
              <span className="font-medium">{r.businessName}</span> ({r.area}) ·{" "}
              {r.status === "draft" ? (
                <span className="text-slate-600">{t("biz.settingUp")}</span>
              ) : r.status === "pending" ? (
                <span className="text-amber-700">{t("biz.waiting")}</span>
              ) : r.status === "approved" ? (
                <span className="text-emerald-700">{t("biz.live")}</span>
              ) : (
                <span className="text-red-700">{r.reason ? t("biz.notLiveYetReason", { reason: r.reason }) : t("biz.notLiveYet")}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface Business {
  id: number;
  name: string;
  suspended: boolean;
  suspendedReason: string | null;
  branches: { id: number; name: string; area: string }[];
  managers: { id: number; name: string; email: string }[];
}

/**
 * The platform owner's view of businesses: who owns which branches, and who
 * manages them — and a way to put venues that joined one by one together as
 * the one business they are.
 */
export function BusinessesPanel({ venues, onChange }: { venues: ManagedVenue[]; onChange: () => void }) {
  const t = useStaffT();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [staff, setStaff] = useState<Admin[]>([]);
  const [name, setName] = useState("");
  const [into, setInto] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [managers, setManagers] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [b, a] = await Promise.all([
      fetch("/api/admin/businesses", { cache: "no-store" }),
      fetch("/api/admin/admins", { cache: "no-store" }),
    ]);
    if (b.ok) setBusinesses((await readJson(b)).businesses);
    if (a.ok) setStaff((await readJson(a)).admins);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const grouped = new Set(businesses.flatMap((b) => b.branches.map((v) => v.id)));
  const loose = venues.filter((v) => !grouped.has(v.id));
  const target = businesses.find((b) => String(b.id) === into);
  const branchIds = new Set([...picked, ...(target?.branches.map((b) => b.id) ?? [])]);
  const promotable = staff.filter((a) => a.venueId !== null && branchIds.has(a.venueId));
  const toggle = (list: number[], id: number) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  /** Every branch off the marketplace at once, or back. */
  async function suspend(b: Business) {
    let reason = "";
    if (!b.suspended) {
      const given = window.prompt(
        t("biz.suspendPrompt", { name: b.name, n: b.branches.length }),
        ""
      );
      if (!given) return;
      reason = given;
    }
    setError(null);
    const res = await fetch("/api/admin/suspensions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: b.id, action: b.suspended ? "lift" : "suspend", reason }),
    });
    const data = await readJson(res);
    if (!res.ok) return setError(t.err(data, t("biz.doFailed")));
    await load();
    onChange();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/admin/businesses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(target ? { businessId: target.id } : { name }),
        venueIds: picked,
        managerIds: managers,
      }),
    });
    const data = await readJson(res);
    if (!res.ok) return setError(t.err(data, t("biz.failed")));
    setBusinesses(data.businesses);
    setName("");
    setInto("");
    setPicked([]);
    setManagers([]);
    await load();
    onChange();
  }

  return (
    <section>
      <h2 className="text-lg font-bold">{t("biz.title")}</h2>
      <p className="mt-1 text-sm text-slate-500">{t("biz.intro")}</p>
      {businesses.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm">
          {businesses.map((b) => (
            <li key={b.id} className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">
                  {b.name}
                  {b.suspended && (
                    <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">
                      {b.suspendedReason ? t("biz.suspendedReason", { reason: b.suspendedReason }) : t("biz.suspended")}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => void suspend(b)}
                  className={`text-xs font-medium underline ${b.suspended ? "text-teal-700" : "text-red-700"}`}
                >
                  {b.suspended ? t("biz.lift") : t("biz.suspend")}
                </button>
              </div>
              <div className="text-slate-600">
                {b.branches.length === 0 ? t("biz.noBranches") : b.branches.map((v) => `${v.name} (${v.area})`).join(" · ")}
              </div>
              <div className="text-xs text-slate-500">
                {t("biz.managedBy", { who: b.managers.length === 0 ? t("biz.nobodyYet") : b.managers.map((m) => m.email).join(", ") })}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="mt-3 space-y-3 rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <select value={into} onChange={(e) => setInto(e.target.value)} className={input} aria-label={t("biz.business")}>
            <option value="">{t("biz.newBusiness")}</option>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {t("biz.addTo", { name: b.name })}
              </option>
            ))}
          </select>
          {!target && (
            <input required minLength={2} placeholder={t("biz.businessName")} aria-label={t("biz.businessName")} value={name} onChange={(e) => setName(e.target.value)} className={`w-56 ${input}`} />
          )}
        </div>
        <fieldset>
          <legend className="font-medium text-slate-700">{t("biz.looseVenues")}</legend>
          {loose.length === 0 && <p className="text-slate-500">{t("biz.allGrouped")}</p>}
          <div className="mt-1 flex flex-wrap gap-3">
            {loose.map((v) => (
              <label key={v.id} className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={picked.includes(v.id)} onChange={() => setPicked(toggle(picked, v.id))} />
                {v.name} <span className="text-slate-400">({v.area})</span>
              </label>
            ))}
          </div>
        </fieldset>
        {promotable.length > 0 && (
          <fieldset>
            <legend className="font-medium text-slate-700">{t("biz.makeManagers")}</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {promotable.map((a) => (
                <label key={a.id} className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={managers.includes(a.id)} onChange={() => setManagers(toggle(managers, a.id))} />
                  {a.email}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <button className="rounded-lg bg-teal-600 px-4 py-2 font-semibold text-white hover:bg-teal-700">
          {target ? t("biz.addTo", { name: target.name }) : t("biz.create")}
        </button>
        {error && <p className="text-red-600">{error}</p>}
      </form>
    </section>
  );
}
