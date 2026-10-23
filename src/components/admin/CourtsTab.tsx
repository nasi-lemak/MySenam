"use client";

import { PeakHoursEditor } from "./PeakHoursEditor";
import { SlotLengthEditor } from "./SlotLengthEditor";
import { OutagesPanel } from "./OutagesPanel";
import { useCallback, useEffect, useState } from "react";
import { ConcessionsEditor } from "./ConcessionsEditor";
import { SportRulesEditor } from "./SportRulesEditor";
import { ACCESS_CODE_STALE_DAYS, MAX_ACCESS_CODE, MAX_CAPACITY, MAX_DEPOSIT, SPORT_ICONS, SPORT_LABELS, SPORTS, usualHours } from "@/lib/types";
import type { Court, Induction, Sport, Venue } from "@/lib/types";
import type { AccessReveal } from "@/lib/store";
import { localTime } from "./shared";
import { SURFACES, SURFACE_SPORTS, type CourtFeatures } from "@/lib/facilities";
import { DICTIONARIES } from "@/lib/i18n";
import { currencySymbol, region } from "@/lib/region";

const SURFACE_LABEL = (x: string) => (DICTIONARIES.en as Record<string, string>)[`surface.${x}`] ?? x;

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
    // The venues this admin manages, not the public list, which is paged.
    const res = await fetch("/api/admin/auth/me", { cache: "no-store" });
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

  /** What a court is like, saved as soon as it is changed. */
  async function saveFeatures(court: Court, change: Partial<CourtFeatures>) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/courts/${court.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Update failed");
      setNotice(`Saved what ${data.court.name} is like.`);
      refreshVenues();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  async function saveLengths(
    court: Court,
    change: { minHours?: number | null; maxHours?: number | null; perPlayer?: boolean; maxPlayers?: number | null }
  ) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/courts/${court.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Update failed");
      setNotice(`Saved how ${data.court.name} is booked.`);
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
                  "Court", "Sport", `Off-peak (${currencySymbol()}/hr)`, `Peak (${currencySymbol()}/hr)`,
                  "Member off-peak", "Member peak", "Capacity", `Deposit (${currencySymbol()})`, "Door", "",
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

      {venue && venue.courts.filter((c) => c.capacity === 1).length > 1 && (
        <CourtLinksEditor key={`links-${venue.id}`} venueId={venue.id} courts={venue.courts.filter((c) => c.capacity === 1)} />
      )}

      {venue && <SlotLengthEditor key={`slots-${venue.id}`} venueId={venue.id} />}

      {venue && <PeakHoursEditor key={venue.id} venueId={venue.id} />}

      {venue && (
        <SportRulesEditor
          key={`sport-rules-${venue.id}`}
          venueId={venue.id}
          sports={[...new Set(venue.courts.map((c) => c.sport))]}
        />
      )}

      {venue && <ConcessionsEditor key={`concessions-${venue.id}`} venueId={venue.id} />}

      {venue && venue.courts.length > 0 && (
        <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="font-semibold">What each court is like</h3>
          <p className="mt-1 text-sm text-slate-500">
            Players compare venues by these and can search for them — air-conditioned badminton, floodlit tennis. Saved
            as soon as you change one.
          </p>
          <table className="mt-2 w-full min-w-[560px] text-sm">
            <tbody>
              {venue.courts.map((court) => (
                <CourtFeaturesRow key={court.id} court={court} onFeatures={(change) => saveFeatures(court, change)} />
              ))}
            </tbody>
          </table>
        </section>
      )}

      {venue && venue.courts.length > 0 && (
        <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="font-semibold">How one booking is sold</h3>
          <p className="mt-1 text-sm text-slate-500">
            Court by court: futsal booked two hours at least, or a hall for a whole afternoon (the usual is one slot up to four
            hours; classes are not held to it). And a court can be priced per player, its rates then a head an hour, with the
            customer saying how many play.
          </p>
          <table className="mt-2 w-full min-w-[480px] text-sm">
            <tbody>
              {venue.courts.map((court) => (
                <tr key={court.id} className="border-t border-slate-100">
                  <td className="py-1.5 pr-3 font-medium">{court.name}</td>
                  <td className="py-1.5 pr-3">
                    <label className="flex items-center gap-1.5 text-xs text-slate-600">
                      At least
                      <select
                        value={court.minHours ?? ""}
                        onChange={(e) => saveLengths(court, { minHours: e.target.value === "" ? null : Number(e.target.value) })}
                        className="rounded-md border border-slate-300 px-1.5 py-1 text-sm"
                      >
                        <option value="">one slot</option>
                        {[1, 1.5, 2, 3, 4].map((h) => (
                          <option key={h} value={h}>
                            {h} {h === 1 ? "hour" : "hours"}
                          </option>
                        ))}
                      </select>
                    </label>
                  </td>
                  <td className="py-1.5">
                    <label className="flex items-center gap-1.5 text-xs text-slate-600">
                      At most
                      <select
                        value={court.maxHours ?? ""}
                        onChange={(e) => saveLengths(court, { maxHours: e.target.value === "" ? null : Number(e.target.value) })}
                        className="rounded-md border border-slate-300 px-1.5 py-1 text-sm"
                      >
                        <option value="">4 hours</option>
                        {[1, 2, 3, 5, 6, 8, 10, 12].map((h) => (
                          <option key={h} value={h}>
                            {h} {h === 1 ? "hour" : "hours"}
                          </option>
                        ))}
                      </select>
                    </label>
                  </td>
                  <td className="py-1.5 pl-3">
                    {court.capacity === 1 && (
                      <span className="flex items-center gap-1.5 text-xs text-slate-600">
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={!!court.perPlayer}
                            onChange={(e) => saveLengths(court, { perPlayer: e.target.checked })}
                          />
                          Per player
                        </label>
                        {court.perPlayer && (
                          <select
                            value={court.maxPlayers ?? ""}
                            onChange={(e) => saveLengths(court, { maxPlayers: e.target.value === "" ? null : Number(e.target.value) })}
                            className="rounded-md border border-slate-300 px-1.5 py-1 text-sm"
                          >
                            <option value="">up to 8</option>
                            {[2, 4, 6, 10, 12, 16, 20, 30].map((n) => (
                              <option key={n} value={n}>
                                up to {n}
                              </option>
                            ))}
                          </select>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {venue && <OutagesPanel key={venue.id} venueId={venue.id} courts={venue.courts} />}

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
          {SPORTS.map((sport) => (
            <option key={sport} value={sport}>
              {SPORT_ICONS[sport]} {SPORT_LABELS[sport]}
            </option>
          ))}
        </select>
        <input
          required
          type="number"
            step={0.01}
          min={0}
          value={newCourt.offPeak}
          onChange={(e) => setNewCourt({ ...newCourt, offPeak: e.target.value })}
          placeholder={`Off-peak ${currencySymbol()}`}
          className="w-28 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          required
          type="number"
            step={0.01}
          min={0}
          value={newCourt.peak}
          onChange={(e) => setNewCourt({ ...newCourt, peak: e.target.value })}
          placeholder={`Peak ${currencySymbol()}`}
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
            step={0.01}
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
        <UsualLengthHint sport={newCourt.sport as Sport} slotMinutes={venue?.slotMinutes ?? 60} />
      </form>
    </div>
  );
}

/**
 * A sport whose game is not an hour (padel's is 90 minutes): what selling it
 * here takes. Slots stay the venue's, so a mixed hall sells by the half hour
 * and gives this court its own shortest booking (ADR 0008).
 */
function UsualLengthHint({ sport, slotMinutes }: { sport: Sport; slotMinutes: number }) {
  const hours = usualHours(sport);
  if (hours === 1) return null;
  const length = `${hours * 60} minutes`;
  return (
    <p className="basis-full text-xs text-slate-500">
      {SPORT_LABELS[sport]} is usually booked for {length}.{" "}
      {slotMinutes === 30
        ? `This venue sells by the half hour, so a ${length} game is three halves; to sell nothing shorter, set this court's shortest booking to ${hours} hours once it is added. Courts sold by the hour beside it want an hour as their shortest.`
        : `This venue sells by the hour, which cannot make a ${length} game. Switch Booked by to half hours (everything already booked stays where it is), then set this court's shortest booking to ${hours} hours if that is all it sells, and the other courts' to an hour.`}
    </p>
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
        {SPORT_ICONS[court.sport]} {SPORT_LABELS[court.sport]}
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
            step={0.01}
          min={0}
          value={offPeak}
          onChange={(e) => setOffPeak(e.target.value)}
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
            step={0.01}
          min={0}
          value={peak}
          onChange={(e) => setPeak(e.target.value)}
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
            step={0.01}
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
            step={0.01}
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
            step={0.01}
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


function CourtFeaturesRow({ court: saved, onFeatures: save }: { court: Court; onFeatures: (change: Partial<CourtFeatures>) => void }) {
  // Shown changed at once, and saved behind it; the saved court replaces it when it comes back.
  const [court, setCourt] = useState(saved);
  useEffect(() => setCourt(saved), [saved]);
  const onFeatures = (change: Partial<CourtFeatures>) => {
    setCourt({ ...court, ...change });
    save(change);
  };
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="w-48 px-3 py-2 font-medium">
        {SPORT_ICONS[court.sport]} {court.name}
      </td>
      <td className="px-3 py-2">
        {/* For players comparing venues; saved as soon as it changes. */}
        <div className="flex min-w-[15rem] flex-wrap items-center gap-2 text-xs">
          <select
            aria-label={`${court.name}: indoor or outdoor`}
            value={court.setting ?? ""}
            onChange={(e) => onFeatures({ setting: e.target.value === "" ? null : (e.target.value as "indoor" | "outdoor") })}
            className="rounded-md border border-slate-200 px-1.5 py-1"
          >
            <option value="">Indoor/outdoor?</option>
            <option value="indoor">Indoor</option>
            <option value="outdoor">Outdoor</option>
          </select>
          <label className="flex items-center gap-1" title="Air-conditioned">
            <input type="checkbox" checked={court.aircon} onChange={(e) => onFeatures({ aircon: e.target.checked })} />
            ❄️ Air-con
          </label>
          <label className="flex items-center gap-1" title="Lit for playing after dark">
            <input type="checkbox" checked={court.floodlit} onChange={(e) => onFeatures({ floodlit: e.target.checked })} />
            💡 Lit
          </label>
          {SURFACE_SPORTS.includes(court.sport) && (
            <select
              aria-label={`${court.name}: surface`}
              value={court.surface ?? ""}
              onChange={(e) => onFeatures({ surface: e.target.value === "" ? null : (e.target.value as CourtFeatures["surface"]) })}
              className="rounded-md border border-slate-200 px-1.5 py-1"
            >
              <option value="">Surface?</option>
              {SURFACES.map((x) => (
                <option key={x} value={x}>
                  {SURFACE_LABEL(x)}
                </option>
              ))}
            </select>
          )}
        </div>
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
          placeholder={region().phone.example}
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

/**
 * One floor sold more than one way (lib/court-links.ts): a futsal pitch that
 * is also four badminton courts. Booking the pitch takes the four; booking
 * any of the four takes the pitch.
 */
function CourtLinksEditor({ venueId, courts }: { venueId: number; courts: Court[] }) {
  const [links, setLinks] = useState<{ wholeId: number; partId: number }[] | null>(null);
  const [editing, setEditing] = useState<{ wholeId: number; parts: number[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/court-links?venueId=${venueId}`, { cache: "no-store" });
    const data = await res.json();
    if (res.ok) setLinks(data.links);
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  const name = (id: number) => courts.find((c) => c.id === id)?.name ?? `Court ${id}`;
  const partsOf = (id: number) => (links ?? []).filter((l) => l.wholeId === id).map((l) => l.partId);
  const isPart = (id: number) => (links ?? []).some((l) => l.partId === id);
  const wholes = [...new Set((links ?? []).map((l) => l.wholeId))];

  async function save() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/court-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courtId: editing.wholeId, parts: editing.parts }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (!links) return null;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">Courts that share a floor</h3>
      <p className="mt-1 text-xs text-slate-500">
        For a hall sold more than one way, like a futsal pitch that is also four badminton courts. Say which courts the bigger
        one takes: booking it then takes all of them, and booking any of them takes it. A block or a court out of service
        closes the courts it shares the floor with too. Only courts booked whole can be linked.
      </p>
      {wholes.length > 0 && (
        <ul className="mt-3 space-y-1">
          {wholes.map((w) => (
            <li key={w} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{name(w)}</span>
              <span className="text-slate-500">takes {partsOf(w).map(name).join(", ")}</span>
              <button
                onClick={() => setEditing({ wholeId: w, parts: partsOf(w) })}
                className="text-xs font-semibold text-teal-700 underline"
              >
                Change
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <label className="flex items-center gap-2">
            Booking
            <select
              value={editing.wholeId}
              onChange={(e) => setEditing({ wholeId: Number(e.target.value), parts: partsOf(Number(e.target.value)) })}
              className="rounded-md border border-slate-300 px-2 py-1"
            >
              {courts
                .filter((c) => !isPart(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
            also takes:
          </label>
          <div className="mt-2 flex flex-wrap gap-3">
            {courts
              .filter((c) => c.id !== editing.wholeId && !wholes.includes(c.id))
              .map((c) => (
                <label key={c.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={editing.parts.includes(c.id)}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        parts: e.target.checked ? [...editing.parts, c.id] : editing.parts.filter((p) => p !== c.id),
                      })
                    }
                  />
                  {c.name}
                </label>
              ))}
          </div>
          <div className="mt-3 flex gap-2">
            <button disabled={busy} onClick={() => void save()} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              Save
            </button>
            <button onClick={() => setEditing(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => {
            const first = courts.find((c) => !isPart(c.id) && !wholes.includes(c.id)) ?? courts[0];
            setEditing({ wholeId: first.id, parts: partsOf(first.id) });
          }}
          className="mt-3 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold"
        >
          Link courts
        </button>
      )}
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
    </section>
  );
}
