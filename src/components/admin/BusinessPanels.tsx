"use client";

import { useCallback, useEffect, useState } from "react";
import type { Admin } from "@/lib/admin-auth";
import type { MapPoint } from "@/components/PinMap";
import PinPicker, { PIN_TEXT_EN } from "@/components/PinPicker";
import type { ManagedVenue } from "./shared";

const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

interface BranchRequest {
  id: number;
  businessName: string;
  area: string;
  status: "pending" | "approved" | "rejected";
  reason: string | null;
  createdAt: string;
}

/**
 * A business manager asking for another branch. It waits for the platform
 * owner, like the business's first application did, unless the install
 * approves branches of approved businesses on its own and its pin and
 * address agree.
 */
export function BranchRequestPanel({ businessName, onChange }: { businessName: string; onChange: () => void }) {
  const [requests, setRequests] = useState<BranchRequest[]>([]);
  const [form, setForm] = useState({ name: "", area: "", address: "", phone: "", message: "" });
  const [pin, setPin] = useState<MapPoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/branches", { cache: "no-store" });
    if (res.ok) setRequests((await res.json()).requests);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!pin) return setError("Drop a pin on the map where the branch is.");
    const res = await fetch("/api/admin/branches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, ...pin }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error ?? "Could not send that.");
    setNotice(
      data.approved
        ? `${form.name} is part of ${businessName} now. Add its courts to open it to customers.`
        : `Asked for ${form.name}. You will get an email when it is approved.`
    );
    setForm({ name: "", area: "", address: "", phone: "", message: "" });
    setPin(null);
    await load();
    onChange();
  }

  return (
    <section>
      <h2 className="text-lg font-bold">Add a branch</h2>
      <p className="mt-1 text-sm text-slate-500">
        Another location for {businessName}. Credit and passes customers buy at any branch work at all of them.
      </p>
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-4">
        <input required minLength={2} placeholder="Branch name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`w-52 ${input}`} />
        <input required minLength={2} placeholder="Area (e.g. Cheras)" value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} className={`w-40 ${input}`} />
        <input required minLength={5} placeholder="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={`w-64 ${input}`} />
        <input required placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={`w-40 ${input}`} />
        <input placeholder="Anything we should know? (optional)" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} className={`min-w-0 flex-1 ${input}`} />
        <div className="w-full">
          <PinPicker
            query={[form.address, form.area].filter((v) => v.trim()).join(", ")}
            pin={pin}
            onPin={setPin}
            text={PIN_TEXT_EN}
          />
        </div>
        <button className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">Ask for this branch</button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {notice && <p className="mt-2 text-sm text-emerald-700">{notice}</p>}
      {requests.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {requests.map((r) => (
            <li key={r.id}>
              <span className="font-medium">{r.businessName}</span> ({r.area}) ·{" "}
              {r.status === "pending" ? (
                <span className="text-amber-700">waiting for approval</span>
              ) : r.status === "approved" ? (
                <span className="text-emerald-700">approved</span>
              ) : (
                <span className="text-red-700">turned down{r.reason ? `: ${r.reason}` : ""}</span>
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
  branches: { id: number; name: string; area: string }[];
  managers: { id: number; name: string; email: string }[];
}

/**
 * The platform owner's view of businesses: who owns which branches, and who
 * manages them — and a way to put venues that joined one by one together as
 * the one business they are.
 */
export function BusinessesPanel({ venues, onChange }: { venues: ManagedVenue[]; onChange: () => void }) {
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
    if (b.ok) setBusinesses((await b.json()).businesses);
    if (a.ok) setStaff((await a.json()).admins);
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
    const data = await res.json();
    if (!res.ok) return setError(data.error ?? "That did not work.");
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
      <h2 className="text-lg font-bold">Businesses</h2>
      <p className="mt-1 text-sm text-slate-500">
        A business owns one or more branches. Its managers sign in once for all of them, and credit and passes bought
        at one branch work at every branch.
      </p>
      {businesses.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm">
          {businesses.map((b) => (
            <li key={b.id} className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="font-semibold">{b.name}</div>
              <div className="text-slate-600">
                {b.branches.length === 0 ? "No branches" : b.branches.map((v) => `${v.name} (${v.area})`).join(" · ")}
              </div>
              <div className="text-xs text-slate-500">
                Managed by {b.managers.length === 0 ? "nobody yet" : b.managers.map((m) => m.email).join(", ")}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="mt-3 space-y-3 rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <select value={into} onChange={(e) => setInto(e.target.value)} className={input} aria-label="Business">
            <option value="">A new business, called…</option>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                Add to {b.name}
              </option>
            ))}
          </select>
          {!target && (
            <input required minLength={2} placeholder="Business name" value={name} onChange={(e) => setName(e.target.value)} className={`w-56 ${input}`} />
          )}
        </div>
        <fieldset>
          <legend className="font-medium text-slate-700">Venues not in a business yet</legend>
          {loose.length === 0 && <p className="text-slate-500">Every venue is in a business.</p>}
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
            <legend className="font-medium text-slate-700">Make managers of the whole business</legend>
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
          {target ? `Add to ${target.name}` : "Create business"}
        </button>
        {error && <p className="text-red-600">{error}</p>}
      </form>
    </section>
  );
}
