"use client";

import { useCallback, useEffect, useState } from "react";
import { formatHour } from "@/lib/time";
import { CLOSE_HOUR, MAX_EMERGENCY_INFO } from "@/lib/types";
import type { Venue, VenueClosure } from "@/lib/types";
import type { Admin } from "@/lib/admin-auth";
import { HOUR_CHOICES, localTime, todayLocal } from "./shared";
import { MessagesPanel } from "./MessagesPanel";
import type { ManagedVenue } from "./shared";

/* ---------------- Venues & staff tab ---------------- */

export function VenuesTab({
  admin,
  venues,
  onChange,
}: {
  admin: Admin;
  venues: ManagedVenue[];
  onChange: () => Promise<Admin | null>;
}) {
  const isOwner = admin.venueId === null;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [newVenue, setNewVenue] = useState({ name: "", area: "", address: "", phone: "" });
  const [newStaff, setNewStaff] = useState({ name: "", email: "", password: "", venueId: "" });

  const loadAdmins = useCallback(async () => {
    if (!isOwner) return;
    const res = await fetch("/api/admin/admins", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setAdmins(data.admins);
  }, [isOwner]);

  useEffect(() => {
    loadAdmins();
  }, [loadAdmins]);

  async function send(
    url: string,
    method: string,
    body: unknown,
    okMessage: string,
    after?: () => void
  ) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setNotice(okMessage);
      await onChange();
      after?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="space-y-5">
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

      <section>
        <h2 className="text-lg font-bold">{isOwner ? "Venues" : "Venue details"}</h2>
        <div className="mt-3 space-y-3">
          {venues.map((venue) => (
            <VenueRow key={venue.id} venue={venue} onSave={send} />
          ))}
          {venues.length === 0 && (
            <p className="text-sm text-slate-500">No venues yet.</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-bold">Closed days</h2>
        <p className="mt-1 text-sm text-slate-500">
          Shut a venue for a whole day — a public holiday, a private hire, a refit.
          Nobody can book or join a waitlist for that date.
        </p>
        <div className="mt-3 space-y-3">
          {venues.map((venue) => (
            <ClosuresRow key={venue.id} venue={venue} onError={setError} onNotice={setNotice} />
          ))}
        </div>
      </section>

      <MessagesPanel venues={venues} />

      {isOwner && <BackupsPanel />}

      {isOwner && <RetentionPanel />}

      {isOwner && (
        <>
          <section>
            <h3 className="font-semibold text-slate-700">Add a venue</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send("/api/admin/venues", "POST", newVenue, `Added ${newVenue.name}.`, () =>
                  setNewVenue({ name: "", area: "", address: "", phone: "" })
                );
              }}
              className="mt-2 flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-4"
            >
              <input
                required minLength={2} placeholder="Venue name" value={newVenue.name}
                onChange={(e) => setNewVenue({ ...newVenue, name: e.target.value })}
                className={`w-48 ${inputClass}`}
              />
              <input
                required minLength={2} placeholder="Area (e.g. Cheras)" value={newVenue.area}
                onChange={(e) => setNewVenue({ ...newVenue, area: e.target.value })}
                className={`w-40 ${inputClass}`}
              />
              <input
                required minLength={2} placeholder="Address" value={newVenue.address}
                onChange={(e) => setNewVenue({ ...newVenue, address: e.target.value })}
                className={`w-64 ${inputClass}`}
              />
              <input
                required minLength={2} placeholder="Phone" value={newVenue.phone}
                onChange={(e) => setNewVenue({ ...newVenue, phone: e.target.value })}
                className={`w-40 ${inputClass}`}
              />
              <button
                type="submit"
                className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
              >
                Add venue
              </button>
            </form>
          </section>

          <section>
            <h2 className="text-lg font-bold">Staff accounts</h2>
            <p className="mt-1 text-sm text-slate-600">
              A venue operator only ever sees their own venue&apos;s bookings, schedule and
              revenue. Leave the venue blank to create another platform owner.
            </p>
            {admins && (
              <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      {["Name", "Email", "Scope", ""].map((h, i) => (
                        <th key={i} className="px-3 py-2 font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {admins.map((a) => (
                      <tr key={a.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-3 py-2 font-medium">{a.name}</td>
                        <td className="px-3 py-2">{a.email}</td>
                        <td className="px-3 py-2">
                          {a.venueId === null ? (
                            <span className="rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-semibold text-violet-700">
                              platform owner
                            </span>
                          ) : (
                            <span className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-semibold text-teal-700">
                              {venues.find((v) => v.id === a.venueId)?.name ?? `Venue ${a.venueId}`}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {a.id !== admin.id && (
                            <button
                              onClick={() => {
                                if (!window.confirm(`Remove ${a.email}?`)) return;
                                send(`/api/admin/admins/${a.id}`, "DELETE", undefined, "Removed.", loadAdmins);
                              }}
                              className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                            >
                              Remove
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(
                  "/api/admin/admins",
                  "POST",
                  { ...newStaff, venueId: newStaff.venueId ? Number(newStaff.venueId) : null },
                  `Added ${newStaff.email}.`,
                  () => {
                    setNewStaff({ name: "", email: "", password: "", venueId: "" });
                    loadAdmins();
                  }
                );
              }}
              className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-4"
            >
              <input
                required minLength={2} placeholder="Name" value={newStaff.name}
                onChange={(e) => setNewStaff({ ...newStaff, name: e.target.value })}
                className={`w-40 ${inputClass}`}
              />
              <input
                required type="email" placeholder="Email" value={newStaff.email}
                onChange={(e) => setNewStaff({ ...newStaff, email: e.target.value })}
                className={`w-52 ${inputClass}`}
              />
              <input
                required type="password" minLength={8} placeholder="Password (8+)"
                value={newStaff.password}
                onChange={(e) => setNewStaff({ ...newStaff, password: e.target.value })}
                className={`w-40 ${inputClass}`}
              />
              <select
                value={newStaff.venueId}
                onChange={(e) => setNewStaff({ ...newStaff, venueId: e.target.value })}
                className={inputClass}
              >
                <option value="">Platform owner (all venues)</option>
                {venues.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
              >
                Add staff
              </button>
            </form>
          </section>
        </>
      )}
    </div>
  );
}

/** Whole-day closures for one venue: list, add, remove. */
function ClosuresRow({
  venue,
  onError,
  onNotice,
}: {
  venue: ManagedVenue;
  onError: (msg: string | null) => void;
  onNotice: (msg: string | null) => void;
}) {
  const [closures, setClosures] = useState<VenueClosure[]>([]);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/venues/${venue.id}/closures`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setClosures(data.closures);
  }, [venue.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function send(url: string, method: string, body?: unknown, okMessage?: string) {
    onError(null);
    onNotice(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      if (okMessage) onNotice(okMessage);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Request failed");
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold">{venue.name}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {closures.length === 0 && (
          <span className="text-xs text-slate-400">No closures scheduled.</span>
        )}
        {closures.map((c) => (
          <span
            key={c.date}
            className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-800"
          >
            {c.date}
            {c.reason ? ` · ${c.reason}` : ""}
            <button
              onClick={() =>
                send(
                  `/api/admin/venues/${venue.id}/closures?date=${c.date}`,
                  "DELETE",
                  undefined,
                  `Re-opened ${c.date}.`
                )
              }
              title="Re-open this day"
              className="font-bold text-amber-700 hover:text-amber-900"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Date
          <input
            type="date"
            min={todayLocal()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 rounded-md border border-slate-200 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Reason (optional)
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Hari Raya"
            className="mt-1 w-56 rounded-md border border-slate-200 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
          />
        </label>
        <button
          disabled={!date}
          onClick={() =>
            send(
              `/api/admin/venues/${venue.id}/closures`,
              "POST",
              { date, reason },
              `Closed ${date}.`
            ).then(() => {
              setDate("");
              setReason("");
            })
          }
          className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-30"
        >
          Close day
        </button>
      </div>
    </div>
  );
}

function VenueRow({
  venue,
  onSave,
}: {
  venue: ManagedVenue;
  onSave: (
    url: string,
    method: string,
    body: unknown,
    okMessage: string,
    after?: () => void
  ) => Promise<void>;
}) {
  const [fields, setFields] = useState({
    name: venue.name,
    area: venue.area,
    address: venue.address,
    phone: venue.phone,
    cancelCutoffHours: venue.cancelCutoffHours,
    openHour: venue.openHour,
    closeHour: venue.closeHour,
    staffedFrom: venue.staffedFrom,
    staffedTo: venue.staffedTo,
    emergencyPhone: venue.emergencyPhone ?? "",
    emergencyInfo: venue.emergencyInfo ?? "",
  });
  const dirty =
    fields.name !== venue.name ||
    fields.area !== venue.area ||
    fields.address !== venue.address ||
    fields.phone !== venue.phone ||
    fields.cancelCutoffHours !== venue.cancelCutoffHours ||
    fields.openHour !== venue.openHour ||
    fields.closeHour !== venue.closeHour ||
    fields.staffedFrom !== venue.staffedFrom ||
    fields.staffedTo !== venue.staffedTo ||
    fields.emergencyPhone !== (venue.emergencyPhone ?? "") ||
    fields.emergencyInfo !== (venue.emergencyInfo ?? "");

  // null on both ends is the default and means somebody is always here.
  const alwaysStaffed = fields.staffedFrom === null || fields.staffedTo === null;
  const neverStaffed = !alwaysStaffed && fields.staffedFrom === fields.staffedTo;

  const inputClass =
    "rounded-md border border-slate-200 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <label className="flex flex-col text-xs font-medium text-slate-500">
        Name
        <input
          value={fields.name}
          onChange={(e) => setFields({ ...fields, name: e.target.value })}
          className={`mt-1 w-52 ${inputClass}`}
        />
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        Area
        <input
          value={fields.area}
          onChange={(e) => setFields({ ...fields, area: e.target.value })}
          className={`mt-1 w-36 ${inputClass}`}
        />
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        Address
        <input
          value={fields.address}
          onChange={(e) => setFields({ ...fields, address: e.target.value })}
          className={`mt-1 w-72 ${inputClass}`}
        />
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        Phone
        <input
          value={fields.phone}
          onChange={(e) => setFields({ ...fields, phone: e.target.value })}
          className={`mt-1 w-36 ${inputClass}`}
        />
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        Opens
        <select
          value={fields.openHour}
          onChange={(e) => setFields({ ...fields, openHour: Number(e.target.value) })}
          className={`mt-1 w-24 ${inputClass}`}
        >
          {HOUR_CHOICES.filter((h) => h < CLOSE_HOUR).map((h) => (
            <option key={h} value={h}>
              {formatHour(h)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        Closes
        <select
          value={fields.closeHour}
          onChange={(e) => setFields({ ...fields, closeHour: Number(e.target.value) })}
          className={`mt-1 w-24 ${inputClass}`}
        >
          {HOUR_CHOICES.filter((h) => h > fields.openHour).map((h) => (
            <option key={h} value={h}>
              {formatHour(h)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        Cancel cutoff (hrs)
        <input
          type="number"
          min={0}
          max={72}
          value={fields.cancelCutoffHours}
          onChange={(e) =>
            setFields({ ...fields, cancelCutoffHours: Number(e.target.value) })
          }
          title="Customers can cancel until this many hours before a booking starts"
          className={`mt-1 w-24 ${inputClass}`}
        />
      </label>
      <div className="w-full border-t border-slate-100 pt-3">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <p className="text-xs font-semibold text-slate-700">Somebody on the counter</p>
            <p className="text-xs text-slate-500">
              Outside these hours the venue runs itself: only resources you have marked unmanned
              can be used, and only by people you have inducted.
            </p>
          </div>
          <label className="flex flex-col text-xs font-medium text-slate-500">
            From
            <select
              value={fields.staffedFrom ?? ""}
              onChange={(e) =>
                setFields({
                  ...fields,
                  staffedFrom: e.target.value === "" ? null : Number(e.target.value),
                  staffedTo: e.target.value === "" ? null : (fields.staffedTo ?? fields.closeHour),
                })
              }
              className={`mt-1 w-28 ${inputClass}`}
            >
              <option value="">Always</option>
              {HOUR_CHOICES.map((h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium text-slate-500">
            To
            <select
              value={fields.staffedTo ?? ""}
              disabled={fields.staffedFrom === null}
              onChange={(e) =>
                setFields({
                  ...fields,
                  staffedTo: e.target.value === "" ? null : Number(e.target.value),
                })
              }
              className={`mt-1 w-28 ${inputClass} disabled:bg-slate-50`}
            >
              <option value="">Always</option>
              {HOUR_CHOICES.map((h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
          </label>
          <span className="pb-1.5 text-xs font-medium text-slate-500">
            {alwaysStaffed
              ? "Somebody is here whenever you are open."
              : neverStaffed
                ? "Nobody is ever on the counter here."
                : `Unstaffed outside ${formatHour(fields.staffedFrom!)}–${formatHour(fields.staffedTo!)}.`}
          </span>
        </div>

        {!alwaysStaffed && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-xs font-medium text-slate-500">
              Emergency number
              <input
                value={fields.emergencyPhone}
                onChange={(e) => setFields({ ...fields, emergencyPhone: e.target.value })}
                placeholder="+60 12-345 6789"
                title="Shown to anybody letting themselves in. A number that is answered at 2 AM."
                className={`mt-1 w-40 ${inputClass}`}
              />
            </label>
            <label className="flex flex-1 flex-col text-xs font-medium text-slate-500">
              What to tell them
              <input
                value={fields.emergencyInfo}
                maxLength={MAX_EMERGENCY_INFO}
                onChange={(e) => setFields({ ...fields, emergencyInfo: e.target.value })}
                placeholder="AED on the wall by the main door. Nearest clinic: Klinik Kesihatan SS2, 5 min."
                className={`mt-1 w-full min-w-[16rem] ${inputClass}`}
              />
            </label>
          </div>
        )}
      </div>

      <span className="text-xs text-slate-400">{venue.courts.length} courts</span>
      <button
        disabled={!dirty}
        onClick={() => onSave(`/api/admin/venues/${venue.id}`, "PATCH", fields, `Saved ${fields.name}.`)}
        className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-30"
      >
        Save
      </button>
    </div>
  );
}

/**
 * Backups, where the person responsible can see them.
 *
 * The schedule does the work; this exists so that "are we backed up?" has an
 * answer that is not "ssh in and look", and so somebody can take one by hand
 * before doing something they are not sure about.
 */
function BackupsPanel() {
  const [state, setState] = useState<{
    backups: { name: string; bytes: number; takenAt: string }[];
    directory: string;
    database: string;
    hoursSinceLast: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/backup", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not read the backups");
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the backups");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function takeOne() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/backup", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Backup failed");
      setNotice(
        `${data.file.name} — ${Math.round(data.file.bytes / 1024)} KB, ${data.bookings} bookings.` +
          (data.pruned.length > 0 ? ` Retired ${data.pruned.length} older.` : "")
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup failed");
    } finally {
      setBusy(false);
    }
  }

  const stale = state !== null && (state.hoursSinceLast === null || state.hoursSinceLast > 48);

  return (
    <section>
      <h2 className="text-lg font-bold">Backups</h2>
      <p className="mt-1 text-sm text-slate-500">
        Everything every venue has is one file. These are the copies of it.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            {state === null ? (
              <span className="text-slate-500">Loading…</span>
            ) : state.hoursSinceLast === null ? (
              <span className="font-semibold text-red-700">
                No backup has ever been taken.
              </span>
            ) : (
              <span className={stale ? "font-semibold text-red-700" : "text-slate-700"}>
                Newest backup {Math.round(state.hoursSinceLast)} hours old
                {stale && " — check the schedule is running"}
              </span>
            )}
          </div>
          <button
            onClick={takeOne}
            disabled={busy}
            className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? "Taking…" : "Back up now"}
          </button>
        </div>

        {state !== null && (
          <>
            <p className="mt-2 text-xs text-slate-500">
              <span className="font-mono">{state.database}</span> →{" "}
              <span className="font-mono">{state.directory}</span>
            </p>
            {state.backups.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                Nothing here yet. Schedule <span className="font-mono">npm run backup</span> daily,
                and keep a copy somewhere that is not this machine.
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      {["Taken", "File", "Size"].map((h) => (
                        <th key={h} className="px-3 py-2 font-semibold">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {state.backups.map((b) => (
                      <tr key={b.name} className="border-b border-slate-100 last:border-0">
                        <td className="whitespace-nowrap px-3 py-2">{b.takenAt}</td>
                        <td className="px-3 py-2 font-mono text-xs">{b.name}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {Math.round(b.bytes / 1024)} KB
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Housekeeping, where the person answerable for it can see it.
 *
 * Keeping a customer's phone number for ever is a decision, whether or not
 * anybody made it on purpose. This shows what the policy is, what it is about
 * to remove, and when it last ran.
 */
function RetentionPanel() {
  const [state, setState] = useState<{
    due: { what: string; days: number; action: string; affected: number }[];
    lastRun: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/retention", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not read the retention policy");
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the retention policy");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runNow() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/retention", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Housekeeping failed");
      setNotice(
        data.total === 0
          ? "Nothing was old enough to remove."
          : `${data.total} records removed or anonymised.`
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Housekeeping failed");
    } finally {
      setBusy(false);
    }
  }

  const due = state?.due.reduce((n, l) => n + l.affected, 0) ?? 0;

  return (
    <section>
      <h2 className="text-lg font-bold">Keeping nothing too long</h2>
      <p className="mt-1 text-sm text-slate-500">
        Personal details are removed once they stop being useful. This runs by itself the first
        time anyone opens the dashboard each day.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-700">
            {state === null
              ? "Loading…"
              : due === 0
                ? "Nothing is currently past its date."
                : `${due} records are past their date.`}
            {state?.lastRun && (
              <span className="text-slate-500"> Last run {localTime(state.lastRun)}.</span>
            )}
          </div>
          <button
            onClick={runNow}
            disabled={busy}
            className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? "Running…" : "Run now"}
          </button>
        </div>

        {state !== null && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[440px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  {["What", "Kept for", "Then", "Due"].map((h) => (
                    <th key={h} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.due.map((line) => (
                  <tr key={line.what} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">{line.what}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                      {line.days === 0 ? "until they expire" : `${line.days} days`}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{line.action}</td>
                    <td className="px-3 py-2 font-medium tabular-nums">
                      {line.affected === 0 ? "—" : line.affected}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-xs text-slate-500">
          A booking is never deleted — its hour and its price are your accounting record. It stops
          naming anybody instead.
        </p>
      </div>
    </section>
  );
}
