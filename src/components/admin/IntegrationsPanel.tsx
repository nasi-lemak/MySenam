"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApiKey } from "@/lib/api-keys";
import type { Endpoint } from "@/lib/webhooks";
import type { ManagedVenue } from "./shared";

/**
 * A venue's own systems: API keys, webhook addresses, and whether it is in
 * the Reserve with Google feeds (lib/api-keys.ts, lib/webhooks.ts,
 * lib/google-feeds.ts). Keys and signing secrets are shown once.
 */
export function IntegrationsPanel({ venues, isOwner }: { venues: ManagedVenue[]; isOwner: boolean }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [google, setGoogle] = useState(false);
  const [keyForm, setKeyForm] = useState({ name: "", scope: "read" });
  const [url, setUrl] = useState("");
  const [shown, setShown] = useState<{ label: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/integrations?venueId=${venueId}`, { cache: "no-store" });
    const d = await res.json();
    if (!res.ok) return setError(d.error ?? "Could not load");
    setKeys(d.keys);
    setEndpoints(d.endpoints);
    setGoogle(d.google);
  }, [venueId]);

  useEffect(() => {
    setOrigin(window.location.origin);
    load();
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setError(null);
    const res = await fetch("/api/admin/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, ...body }),
    });
    const d = await res.json();
    if (!res.ok) {
      setError(d.error ?? "Request failed");
      return null;
    }
    await load();
    return d;
  }

  const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">API and webhooks</h2>
        {venues.length > 1 && (
          <select value={venueId} onChange={(e) => setVenueId(Number(e.target.value))} aria-label="Venue" className="rounded-md border border-slate-300 px-2 py-1 text-sm">
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        For your own systems: a screen at the desk, your website, your door or accounting software. The API is at{" "}
        <code className="rounded bg-slate-100 px-1">{origin}/api/v1</code> with the header{" "}
        <code className="rounded bg-slate-100 px-1">Authorization: Bearer &lt;key&gt;</code>: <code>GET /venue</code>,{" "}
        <code>GET /availability?date=</code>, <code>GET /bookings?from=&amp;to=</code>, <code>GET /bookings/&lt;code&gt;</code>, and with a write
        key <code>POST /bookings</code> and <code>POST /bookings/&lt;code&gt;/cancel</code>.
      </p>
      <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        A key sees your bookings with customers&apos; names and numbers, and a write key can book and cancel: give one only to
        a system you trust, keep it out of web pages and apps people can open, and revoke it when it is no longer used.
        Whoever you give it to handles your customers&apos; data for you.
      </div>
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      {shown && (
        <div className="mt-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm">
          <p className="font-semibold">{shown.label}: copy it now, it will not be shown again.</p>
          <p className="mt-1 break-all font-mono text-xs">{shown.value}</p>
          <div className="mt-1 flex gap-3">
            <button type="button" className="font-medium text-teal-700 underline" onClick={() => void navigator.clipboard?.writeText(shown.value)}>
              Copy
            </button>
            <button type="button" className="font-medium text-slate-600 underline" onClick={() => setShown(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      <h3 className="mt-4 font-semibold">API keys</h3>
      <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
        {keys.length === 0 && <li className="p-2 text-slate-500">None yet.</li>}
        {keys.map((k) => (
          <li key={k.id} className={`flex flex-wrap items-center justify-between gap-2 p-2 ${k.revokedAt ? "text-slate-400" : ""}`}>
            <span>
              <span className="font-medium">{k.name}</span> · <code>{k.prefix}…</code> · {k.scope === "write" ? "read and write" : k.scope === "availability" ? "availability only" : "read only"}
              <span className="block text-xs text-slate-500">
                {k.revokedAt ? `revoked ${k.revokedAt.slice(0, 10)}` : k.lastUsedAt ? `last used ${k.lastUsedAt.slice(0, 16)}` : "not used yet"}
              </span>
            </span>
            {!k.revokedAt && (
              <button
                type="button"
                className="font-medium text-rose-700 underline"
                onClick={() => {
                  if (window.confirm(`Revoke "${k.name}"? Anything using it stops working at once.`)) void act({ action: "revoke", id: k.id });
                }}
              >
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <input className={input} placeholder="What will use it" value={keyForm.name} onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })} aria-label="Key name" />
        <select className={input} value={keyForm.scope} onChange={(e) => setKeyForm({ ...keyForm, scope: e.target.value })} aria-label="Key scope">
          <option value="availability">Availability only (for a website: no customer details)</option>
          <option value="read">Read only</option>
          <option value="write">Read and write (books and cancels)</option>
        </select>
        <button
          type="button"
          className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white"
          onClick={async () => {
            const d = await act({ action: "key", ...keyForm });
            if (d) {
              setShown({ label: `API key "${d.record.name}"`, value: d.key });
              setKeyForm({ name: "", scope: "read" });
            }
          }}
        >
          Make a key
        </button>
      </div>

      <h3 className="mt-4 font-semibold">Webhooks</h3>
      <p className="text-xs text-slate-500">
        We POST <code>booking.created</code>, <code>booking.cancelled</code>, <code>booking.paid</code> and <code>booking.changed</code> to these
        HTTPS addresses, signed in the <code>MySenam-Signature</code> header with the address&apos;s secret. Check the signature before
        trusting a message. An address failing for a day is turned off and you are emailed.
      </p>
      <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
        {endpoints.length === 0 && <li className="p-2 text-slate-500">None yet.</li>}
        {endpoints.map((e) => (
          <li key={e.id} className="p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-all">
                <span className="font-medium">{e.url}</span>{" "}
                <span className={`text-xs ${e.active ? (e.failingSince ? "text-amber-700" : "text-emerald-700") : "text-rose-700"}`}>
                  {e.active ? (e.failingSince ? `failing since ${e.failingSince.slice(0, 16)}` : "on") : "turned off"}
                </span>
              </span>
              <span className="flex gap-3">
                {e.active ? (
                  <button type="button" className="font-medium text-teal-700 underline" onClick={() => void act({ action: "ping", id: e.id })}>
                    Send a test
                  </button>
                ) : (
                  <button type="button" className="font-medium text-teal-700 underline" onClick={() => void act({ action: "resume", id: e.id })}>
                    Turn back on
                  </button>
                )}
                <button type="button" className="font-medium text-rose-700 underline" onClick={() => void act({ action: "remove", id: e.id })}>
                  Remove
                </button>
              </span>
            </div>
            {e.recent.length > 0 && (
              <ul className="mt-1 text-xs text-slate-500">
                {e.recent.slice(0, 5).map((d, i) => (
                  <li key={i}>
                    {d.at.slice(0, 16)} {d.event}: {d.deliveredAt ? `delivered (${d.status})` : d.error ? `${d.error}, tried ${d.attempts}×` : "waiting"}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <input className={`${input} min-w-[18rem]`} placeholder="https://example.com/mysenam-hook" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Webhook address" />
        <button
          type="button"
          className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white"
          onClick={async () => {
            const d = await act({ action: "webhook", url });
            if (d) {
              setShown({ label: "Signing secret for that address", value: d.secret });
              setUrl("");
            }
          }}
        >
          Add address
        </button>
      </div>

      <h3 className="mt-4 font-semibold">Reserve with Google</h3>
      <label className="mt-1 flex items-start gap-2 text-sm">
        <input type="checkbox" checked={google} onChange={(e) => void act({ action: "google", on: e.target.checked })} className="mt-1" />
        <span>
          Include this venue in the feeds for Google&apos;s Reserve with Google. Nothing appears on Google until the platform is an
          approved Google partner and its booking connection is live; until then this only says you want to be in.
        </span>
      </label>
      {isOwner && (
        <p className="mt-1 text-xs text-slate-500">
          Platform feeds (draft, for partner onboarding):{" "}
          {(["merchants", "services", "availability"] as const).map((f) => (
            <a key={f} href={`/api/admin/google-feeds?feed=${f}`} className="mr-2 font-medium text-teal-700 underline">
              {f}.json
            </a>
          ))}
        </p>
      )}
    </section>
  );
}
