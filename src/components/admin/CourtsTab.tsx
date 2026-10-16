"use client";

import { useCallback, useEffect, useState } from "react";
import { ACCESS_CODE_STALE_DAYS, MAX_ACCESS_CODE, MAX_CAPACITY, MAX_DEPOSIT, SPORT_ICONS } from "@/lib/types";
import type { Court, Induction, Venue } from "@/lib/types";
import type { AccessReveal } from "@/lib/store";
import { localTime } from "./shared";

/** What one row of the courts table can change in a save. */
interface CourtEdits {
  name: string;
  offPeak: string;
  peak: string;
  capacity: string;
  memberOffPeak: string;
  memberPeak: string;
  deposit: string;
}

/* ---------------- Courts & rates tab ---------------- */

export function CourtsTab({
  venues,
  onVenuesChange,
}: {
  venues: (Venue & { courts: Court[] })[];
  onVenuesChange: (venues: (Venue & { courts: Court[] })[]) => void;
}) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The door being looked at. The code is fetched only when staff ask for it,
  // so it is not sitting on a counter screen all shift.
  const [door, setDoor] = useState<{
    court: Court;
    code: string;
    changedAt: string | null;
    stale: boolean;
    unmanned: boolean;
  } | null>(null);
  const [reveals, setReveals] = useState<AccessReveal[] | null>(null);
  const [newCourt, setNewCourt] = useState({
    name: "",
    sport: "badminton",
    offPeak: "",
    peak: "",
    capacity: "1",
    deposit: "0",
  });

  const venue = venues.find((v) => v.id === venueId);

  async function refreshVenues() {
    const res = await fetch("/api/venues", { cache: "no-store" });
    const data = await res.json();
    onVenuesChange(data.venues);
  }

  async function saveCourt(court: Court, edits: CourtEdits) {
    const { name, offPeak, peak, capacity, memberOffPeak, memberPeak, deposit } = edits;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/courts/${court.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          offPeakRate: Number(offPeak),
          peakRate: Number(peak),
          capacity: Number(capacity),
          // Blank means "no member discount on this court".
          memberOffPeakRate: memberOffPeak.trim() === "" ? null : Number(memberOffPeak),
          memberPeakRate: memberPeak.trim() === "" ? null : Number(memberPeak),
          deposit: Number(deposit),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Update failed");
      setNotice(`Saved ${data.court.name}.`);
      refreshVenues();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  /** Open the door panel for a court, fetching its current code. */
  async function openDoor(court: Court) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/courts/${court.id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load the door");
      setDoor({
        court,
        code: data.access.code ?? "",
        changedAt: data.access.changedAt,
        stale: data.access.stale,
        unmanned: data.court.unmanned,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the door");
    }
  }

  /**
   * Save what staff have programmed into the lock. MySenam only relays the
   * code, so this never invents one: a code the lock has not been told about
   * would shut out the one person entitled to be there.
   */
  async function saveDoor(changes: { unmanned?: boolean; accessCode?: string | null }) {
    if (!door) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/courts/${door.court.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save the door");
      setDoor({
        court: data.court,
        code: data.access.code ?? "",
        changedAt: data.access.changedAt,
        stale: data.access.stale,
        unmanned: data.court.unmanned,
      });
      setNotice(
        data.court.unmanned
          ? `${data.court.name} is unmanned — customers with a paid booking see the code an hour before their slot.`
          : `${data.court.name} is staffed. No code is given out for it.`
      );
      refreshVenues();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the door");
    }
  }

  /** Who has been let in, on demand rather than on every page load. */
  async function loadReveals() {
    setError(null);
    try {
      const res = await fetch(`/api/admin/access?venueId=${venueId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load the door log");
      setReveals(data.reveals);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the door log");
    }
  }

  async function addCourt(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/courts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId,
          name: newCourt.name,
          sport: newCourt.sport,
          offPeakRate: Number(newCourt.offPeak),
          peakRate: Number(newCourt.peak),
          capacity: Number(newCourt.capacity),
          deposit: Number(newCourt.deposit),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not add court");
      setNotice(`Added ${data.court.name}.`);
      setNewCourt({
        name: "",
        sport: newCourt.sport,
        offPeak: "",
        peak: "",
        capacity: "1",
        deposit: "0",
      });
      refreshVenues();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add court");
    }
  }

  return (
    <div className="space-y-4">
      <select
        value={venueId}
        onChange={(e) => setVenueId(Number(e.target.value))}
        className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
      >
        {venues.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      {venue && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                {[
                  "Court", "Sport", "Off-peak (RM/hr)", "Peak (RM/hr)",
                  "Member off-peak", "Member peak", "Capacity", "Deposit (RM)", "Door", "",
                ].map((h, i) => (
                  <th key={i} className="px-3 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {venue.courts.map((court) => (
                <CourtRow
                  key={court.id}
                  court={court}
                  onSave={saveCourt}
                  onDoor={() => openDoor(court)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {door && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold">The door on {door.court.name}</p>
            <button
              onClick={() => setDoor(null)}
              className="text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              Close
            </button>
          </div>
          <p className="mt-0.5 text-xs text-slate-600">
            Type in the code you have programmed into the lock. The booking system only passes it on — it
            never changes the lock, so a code invented here would shut everybody out.
          </p>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-600">Code on the lock</label>
              <input
                value={door.code}
                onChange={(e) => setDoor({ ...door, code: e.target.value })}
                maxLength={MAX_ACCESS_CODE}
                placeholder="4821"
                className="mt-1 w-32 rounded-md border border-slate-300 px-2 py-1 font-mono text-sm tracking-widest focus:border-teal-500 focus:outline-none"
              />
            </div>
            <button
              onClick={() => saveDoor({ accessCode: door.code })}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
            >
              Save code
            </button>
            <button
              onClick={() => saveDoor({ unmanned: !door.unmanned })}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                door.unmanned
                  ? "border border-slate-300 text-slate-600 hover:bg-slate-50"
                  : "bg-teal-600 text-white hover:bg-teal-700"
              }`}
            >
              {door.unmanned ? "Put someone on this door" : "Leave this one unmanned"}
            </button>
            {door.code !== "" && (
              <button
                onClick={() => saveDoor({ accessCode: null })}
                title="Forget the code. The resource stops being unmanned."
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-red-600"
              >
                Clear
              </button>
            )}
          </div>

          <p className="mt-2 text-xs text-slate-600">
            {door.unmanned
              ? "Unmanned. A customer with a paid booking sees this code an hour before their slot, and that counts as their arrival."
              : "Staffed. Nobody is given a code for this one."}
            {door.changedAt && ` Code last changed ${localTime(door.changedAt)}.`}
          </p>
          {door.stale && (
            <p className="mt-1 text-xs font-medium text-red-700">
              This code has not changed in over {ACCESS_CODE_STALE_DAYS} days. Change it on the
              lock, then type the new one in here.
            </p>
          )}
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">Who has been let in</p>
            <p className="text-xs text-slate-500">
              Every time a door code was shown, newest first. This is the list you want when a
              court is found in a state.
            </p>
          </div>
          <button
            onClick={() => (reveals === null ? loadReveals() : setReveals(null))}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-teal-500 hover:text-teal-700"
          >
            {reveals === null ? "Show log" : "Hide"}
          </button>
        </div>
        {reveals !== null &&
          (reveals.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">
              Nobody has been given a code at this venue yet.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[460px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    {["When", "Code", "Court", "Customer", "Phone"].map((h) => (
                      <th key={h} className="px-3 py-2 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reveals.map((r, i) => (
                    <tr key={i} className="border-b border-slate-100 last:border-0">
                      <td className="whitespace-nowrap px-3 py-2">{localTime(r.revealedAt)}</td>
                      <td className="px-3 py-2 font-mono text-teal-700">{r.bookingCode}</td>
                      <td className="px-3 py-2">{r.courtName}</td>
                      <td className="px-3 py-2">{r.name}</td>
                      <td className="whitespace-nowrap px-3 py-2">{r.phone}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </div>

      <InductionsPanel venueId={venueId} />

      <form
        onSubmit={addCourt}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-slate-300 bg-white p-4"
      >
        <div className="text-sm font-semibold text-slate-700">Add court:</div>
        <input
          required
          minLength={2}
          value={newCourt.name}
          onChange={(e) => setNewCourt({ ...newCourt, name: e.target.value })}
          placeholder="Court name"
          className="w-44 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <select
          value={newCourt.sport}
          onChange={(e) => setNewCourt({ ...newCourt, sport: e.target.value })}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        >
          {Object.entries(SPORT_ICONS).map(([sport, icon]) => (
            <option key={sport} value={sport}>
              {icon} {sport}
            </option>
          ))}
        </select>
        <input
          required
          type="number"
          min={1}
          value={newCourt.offPeak}
          onChange={(e) => setNewCourt({ ...newCourt, offPeak: e.target.value })}
          placeholder="Off-peak RM"
          className="w-28 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          required
          type="number"
          min={1}
          value={newCourt.peak}
          onChange={(e) => setNewCourt({ ...newCourt, peak: e.target.value })}
          placeholder="Peak RM"
          className="w-28 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          required
          type="number"
          min={1}
          max={MAX_CAPACITY}
          value={newCourt.capacity}
          onChange={(e) => setNewCourt({ ...newCourt, capacity: e.target.value })}
          title="1 for an exclusive court; higher for a shared facility like a gym floor"
          placeholder="Capacity"
          className="w-24 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          type="number"
          min={0}
          max={MAX_DEPOSIT}
          value={newCourt.deposit}
          onChange={(e) => setNewCourt({ ...newCourt, deposit: e.target.value })}
          title="Deposit held while the kit is out. 0 for anything that stays on site."
          placeholder="Deposit"
          className="w-24 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          Add
        </button>
      </form>
    </div>
  );
}

function CourtRow({
  court,
  onSave,
  onDoor,
}: {
  court: Court;
  onSave: (court: Court, edits: CourtEdits) => void;
  onDoor: () => void;
}) {
  const [name, setName] = useState(court.name);
  const [offPeak, setOffPeak] = useState(String(court.offPeakRate));
  const [peak, setPeak] = useState(String(court.peakRate));
  const [capacity, setCapacity] = useState(String(court.capacity));
  const [memberOffPeak, setMemberOffPeak] = useState(
    court.memberOffPeakRate === null ? "" : String(court.memberOffPeakRate)
  );
  const [memberPeak, setMemberPeak] = useState(
    court.memberPeakRate === null ? "" : String(court.memberPeakRate)
  );
  const [deposit, setDeposit] = useState(String(court.deposit));
  const asText = (v: number | null) => (v === null ? "" : String(v));
  const dirty =
    name !== court.name ||
    offPeak !== String(court.offPeakRate) ||
    peak !== String(court.peakRate) ||
    capacity !== String(court.capacity) ||
    memberOffPeak !== asText(court.memberOffPeakRate) ||
    memberPeak !== asText(court.memberPeakRate) ||
    deposit !== String(court.deposit);

  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="px-3 py-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-44 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        {SPORT_ICONS[court.sport]} {court.sport}
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min={1}
          value={offPeak}
          onChange={(e) => setOffPeak(e.target.value)}
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min={1}
          value={peak}
          onChange={(e) => setPeak(e.target.value)}
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min={0}
          value={memberOffPeak}
          onChange={(e) => setMemberOffPeak(e.target.value)}
          placeholder="—"
          title="What a member pays off-peak. Leave blank for no member discount."
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min={0}
          value={memberPeak}
          onChange={(e) => setMemberPeak(e.target.value)}
          placeholder="—"
          title="What a member pays at peak. Leave blank for no member discount."
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min={1}
          max={MAX_CAPACITY}
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          title="1 for an exclusive court; higher for a shared facility"
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min={0}
          max={MAX_DEPOSIT}
          value={deposit}
          onChange={(e) => setDeposit(e.target.value)}
          title="Held at the desk while the kit is out. 0 for anything that stays put, like a court."
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <button
          onClick={onDoor}
          title="The code on this door, and who has been given it"
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold transition ${
            court.unmanned
              ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
              : "bg-slate-100 text-slate-500 hover:bg-slate-200"
          }`}
        >
          {court.unmanned ? "unmanned" : "staffed"}
        </button>
      </td>
      <td className="px-3 py-2">
        <button
          disabled={!dirty}
          onClick={() =>
            onSave(court, { name, offPeak, peak, capacity, memberOffPeak, memberPeak, deposit })
          }
          className="rounded-md bg-teal-600 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-30"
        >
          Save
        </button>
      </td>
    </tr>
  );
}

/**
 * Who may use this venue when nobody is on the counter.
 *
 * The induction is the thing that makes unstaffed hours defensible rather than
 * reckless: somebody was shown the emergency button, the rules and the way out,
 * in person, by a named member of staff. So it is recorded here and never by
 * the customer.
 */
function InductionsPanel({ venueId }: { venueId: number }) {
  const [inductions, setInductions] = useState<Induction[] | null>(null);
  const [form, setForm] = useState({ phone: "", name: "", note: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/inductions?venueId=${venueId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load inductions");
      setInductions(data.inductions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load inductions");
      setInductions(null);
    }
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/inductions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...form }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not record the induction");
      setNotice(`${data.induction.name} can now use this venue out of hours.`);
      setForm({ phone: "", name: "", note: "" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the induction");
    }
  }

  async function revoke(induction: Induction) {
    if (!window.confirm(`Withdraw out-of-hours access for ${induction.name}?`)) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/inductions/${induction.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not withdraw access");
      setNotice(`${induction.name} can no longer get in out of hours.`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not withdraw access");
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <p className="text-sm font-semibold">Cleared for unstaffed hours</p>
      <p className="text-xs text-slate-500">
        Record this after you have walked somebody round in person: the emergency button, the
        rules, and their IC. Nobody gets a door code out of hours without it.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-2">
        <input
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Name"
          className="w-40 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          required
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          placeholder="012-345 6789"
          className="w-36 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
          placeholder="IC checked, shown the alarm"
          className="w-56 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700"
        >
          Record induction
        </button>
      </form>

      {inductions !== null &&
        (inductions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            Nobody is cleared for unstaffed hours here yet.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  {["Name", "Phone", "Inducted", "By", "Note", ""].map((h, i) => (
                    <th key={i} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inductions.map((i) => (
                  <tr
                    key={i.id}
                    className={`border-b border-slate-100 last:border-0 ${
                      i.revokedAt ? "text-slate-400" : ""
                    }`}
                  >
                    <td className="px-3 py-2 font-medium">{i.name}</td>
                    <td className="whitespace-nowrap px-3 py-2">{i.phone}</td>
                    <td className="whitespace-nowrap px-3 py-2">{localTime(i.createdAt)}</td>
                    <td className="px-3 py-2">{i.adminName ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-500">{i.note ?? "—"}</td>
                    <td className="px-3 py-2 text-right">
                      {i.revokedAt ? (
                        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold">
                          withdrawn
                        </span>
                      ) : (
                        <button
                          onClick={() => revoke(i)}
                          className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                        >
                          Withdraw
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
