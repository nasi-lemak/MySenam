"use client";

import { useCallback, useEffect, useState } from "react";
import type { AccessEntry, AccessKind, AccessSettings, VenueAccess } from "@/lib/access";

const MODES: { value: VenueAccess; label: string; note: string }[] = [
  {
    value: "public",
    label: "Public",
    note: "Anyone can find it in search and book. A commercial badminton centre or futsal facility.",
  },
  {
    value: "members",
    label: "Members only",
    note: "Bookings need a membership here, or a place on the list below. It can still show in search so new members can find you. A private club taking new members.",
  },
  {
    value: "private",
    label: "Private",
    note: "In no search or list. Only people on the list below — and your staff — can open its page and book. A condominium's courts, pool or gym.",
  },
];

const KIND_LABELS: Record<AccessKind, string> = { resident: "Resident", member: "Member", guest: "Guest" };

interface State {
  settings: AccessSettings;
  list: AccessEntry[];
  phoneChecks: boolean;
}

/**
 * Who one venue is for — public, members only or private — and the list of
 * people it lets in, by phone number: one at a time, or pasted from the
 * management office's spreadsheet.
 */
export function AccessEditor({ venueId }: { venueId: number }) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<State | null>(null);
  const [mode, setMode] = useState<VenueAccess>("public");
  const [listed, setListed] = useState(true);
  const [note, setNote] = useState("");
  const [person, setPerson] = useState({ phone: "", name: "", label: "", kind: "resident" as AccessKind, expiresOn: "" });
  const [paste, setPaste] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const take = (data: State) => {
    setS((old) => ({ ...data, phoneChecks: data.phoneChecks ?? old?.phoneChecks ?? false }));
    setMode(data.settings.access);
    setListed(data.settings.access !== "members" || data.settings.listed);
    setNote(data.settings.note ?? "");
  };

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/venue-access?venueId=${venueId}`, { cache: "no-store" });
    if (res.ok) take(await res.json());
  }, [venueId]);

  useEffect(() => {
    if (open && s === null) void load();
  }, [open, s, load]);

  async function post(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/venue-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      take(data);
      setNotice(typeof data.added === "number" ? `${data.added} added, ${data.updated} updated.` : ok);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const input = "rounded-md border border-slate-300 px-2 py-1 text-sm";
  const current = s?.settings.access ?? "public";
  return (
    <div className="mt-3">
      <button onClick={() => setOpen(!open)} className="text-xs font-medium text-teal-700 underline">
        {open ? "Hide who it is for" : s ? `Who it is for: ${MODES.find((m) => m.value === current)?.label}` : "Who it is for: public, members or private"}
      </button>
      {open && s && (
        <div className="mt-2 space-y-4 rounded-xl border border-slate-200 bg-white p-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Who can find and book this venue</legend>
            {MODES.map((m) => (
              <label key={m.value} className="flex gap-2 text-sm">
                <input type="radio" name={`access-${venueId}`} checked={mode === m.value} onChange={() => setMode(m.value)} className="mt-1" />
                <span>
                  <span className="font-medium">{m.label}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">{m.note}</span>
                </span>
              </label>
            ))}
            {mode === "members" && (
              <label className="ml-6 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} />
                Show it in search, so people can find it and ask to join
              </label>
            )}
            {mode !== "public" && (
              <label className="block text-sm">
                What somebody not on the list is told
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  maxLength={500}
                  placeholder={mode === "members" ? "e.g. Membership RM150 a year — ask at the counter or WhatsApp 012-345 6789." : "e.g. Residents of Taman Indah only. Not on the list? Contact the management office."}
                  className={`mt-1 w-full ${input}`}
                />
              </label>
            )}
            <button
              disabled={busy}
              onClick={() => post({ action: "settings", access: mode, listed, note }, "Saved.")}
              className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              Save
            </button>
          </fieldset>

          {(current !== "public" || s.list.length > 0) && (
            <div className="space-y-3 border-t border-slate-100 pt-3">
              <p className="text-sm font-semibold">
                The list ({s.list.length}) {current === "members" && <span className="font-normal text-slate-500">— on top of anyone with an active membership</span>}
              </p>
              <p className="text-xs text-slate-500">
                Matched by the phone number on the customer&apos;s account
                {s.phoneChecks ? ", once they have checked it" : " (this site does not check numbers, so anyone who types a number on the list gets in — set up phone checks before relying on it)"}.
                Guests drop off after their end date.
              </p>
              {s.list.length > 0 && (
                <div className="max-h-72 overflow-auto rounded-lg border border-slate-200">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-slate-50 uppercase text-slate-500">
                      <tr>
                        <th className="px-2 py-1">Phone</th>
                        <th className="px-2 py-1">Name</th>
                        <th className="px-2 py-1">Unit / no.</th>
                        <th className="px-2 py-1">As</th>
                        <th className="px-2 py-1">Until</th>
                        <th className="px-2 py-1">Account</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {s.list.map((e) => (
                        <tr key={e.id}>
                          <td className="px-2 py-1 font-mono">{e.phone}</td>
                          <td className="px-2 py-1">{e.name ?? ""}</td>
                          <td className="px-2 py-1">{e.label ?? ""}</td>
                          <td className="px-2 py-1">{KIND_LABELS[e.kind]}</td>
                          <td className="px-2 py-1">{e.expiresOn ?? "—"}</td>
                          <td className="px-2 py-1">{e.hasAccount ? "✓" : ""}</td>
                          <td className="px-2 py-1 text-right">
                            <button
                              disabled={busy}
                              onClick={() => window.confirm(`Take ${e.name ?? e.phone} off the list?`) && post({ action: "remove", id: e.id }, "Removed.")}
                              className="text-red-600 hover:underline"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <input aria-label="Phone" placeholder="Phone" value={person.phone} onChange={(e) => setPerson({ ...person, phone: e.target.value })} className={`${input} w-36`} />
                <input aria-label="Name" placeholder="Name" value={person.name} onChange={(e) => setPerson({ ...person, name: e.target.value })} className={`${input} w-36`} />
                <input aria-label="Unit or number" placeholder="Unit / no." value={person.label} onChange={(e) => setPerson({ ...person, label: e.target.value })} className={`${input} w-24`} />
                <select aria-label="As" value={person.kind} onChange={(e) => setPerson({ ...person, kind: e.target.value as AccessKind })} className={input}>
                  {(Object.keys(KIND_LABELS) as AccessKind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
                {person.kind === "guest" && (
                  <label className="text-xs text-slate-600">
                    until{" "}
                    <input type="date" value={person.expiresOn} onChange={(e) => setPerson({ ...person, expiresOn: e.target.value })} className={input} />
                  </label>
                )}
                <button
                  disabled={busy || person.phone.trim() === ""}
                  onClick={async () => {
                    if (await post({ action: "add", ...person }, "Added.")) setPerson({ phone: "", name: "", label: "", kind: person.kind, expiresOn: "" });
                  }}
                  className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Add
                </button>
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer text-xs font-medium text-teal-700">Paste many from a spreadsheet</summary>
                <p className="mt-1 text-xs text-slate-500">
                  One person a line: <span className="font-mono">phone, name, unit</span> — name and unit optional. A number already on
                  the list is updated, not doubled.
                </p>
                <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={5} placeholder={"0123456789, Aisyah Rahman, A-12-3\n0198765432, Lee Wei, B-05-1"} className={`mt-1 w-full font-mono ${input}`} />
                <button
                  disabled={busy || paste.trim() === ""}
                  onClick={async () => {
                    if (await post({ action: "import", text: paste, kind: person.kind === "guest" ? "resident" : person.kind }, "Imported.")) setPaste("");
                  }}
                  className="mt-1 rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Add them as {person.kind === "member" ? "members" : "residents"}
                </button>
              </details>
            </div>
          )}
          {error && <p className="text-sm font-medium text-red-700">{error}</p>}
          {notice && <p className="text-sm font-medium text-emerald-700">{notice}</p>}
        </div>
      )}
    </div>
  );
}
