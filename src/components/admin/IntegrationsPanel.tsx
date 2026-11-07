"use client";

import { readJson } from "@/lib/read-response";
import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import type { AiPersonalData } from "@/lib/ai-personal-data";
import type { ApiKey } from "@/lib/api-keys";
import type { Endpoint } from "@/lib/webhooks";
import type { ManagedVenue } from "./shared";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/** A phrase with `{name}` places filled by elements (code samples), in the phrase's own word order. */
function withParts(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((piece, i) => (i % 2 === 1 ? <Fragment key={i}>{parts[piece] ?? piece}</Fragment> : piece));
}

/**
 * A venue's own systems: API keys, webhook addresses, and whether it is in
 * the Reserve with Google feeds (lib/api-keys.ts, lib/webhooks.ts,
 * lib/google-feeds.ts). Keys and signing secrets are shown once.
 */
export function IntegrationsPanel({ venues, isOwner }: { venues: ManagedVenue[]; isOwner: boolean }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [retry, setRetry] = useState({ tries: 8, days: 30, most: 50 });
  const [notice, setNotice] = useState<string | null>(null);
  const [google, setGoogle] = useState(false);
  const [ai, setAi] = useState<AiPersonalData>({ on: false, changedAt: null, changedBy: null });
  const [keyForm, setKeyForm] = useState({ name: "", scope: "read", venueOwned: false });
  const [url, setUrl] = useState("");
  const [hookVenueOwned, setHookVenueOwned] = useState(false);
  const [me, setMe] = useState(0);
  const [shown, setShown] = useState<{ label: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/integrations?venueId=${venueId}`, { cache: "no-store" });
    const d = await readJson(res);
    if (!res.ok) return setError(t.err(d, t("int.couldNotLoad")));
    setKeys(d.keys);
    setMe(d.me ?? 0);
    setEndpoints(d.endpoints);
    if (d.webhookRetry) setRetry(d.webhookRetry);
    setGoogle(d.google);
    setAi(d.aiPersonalData);
  }, [venueId, t]);

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
    const d = await readJson(res);
    if (!res.ok) {
      setError(t.err(d, t("int.requestFailed")));
      return null;
    }
    await load();
    return d;
  }

  /** Failed deliveries sent again (one, or all of an address's): what happened, said plainly. */
  async function sendAgain(body: Record<string, unknown>) {
    setNotice(null);
    const d = await act({ action: "redeliver", ...body });
    if (d) setNotice(d.requeued > 0 ? t("whd.queued", { n: d.requeued }) : t("whd.nothingQueued"));
  }

  const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  /** Whose a key or address is, and why it stopped where the system stopped it (ADR 0064). */
  const whose = (x: { ownership: string; ownerName: string | null; madeBy: string | null; ownerLost: boolean }, stopped: string | null) =>
    stopped === "owner_removed"
      ? t("sec.stopped.owner_removed")
      : stopped === "owner_demoted"
        ? t("sec.stopped.owner_demoted")
        : stopped === "rotated"
          ? t("sec.stopped.rotated")
          : x.ownerLost
            ? t("sec.stopped.ownerLost")
            : x.ownership === "person"
              ? t("sec.owner.person", { name: x.ownerName ?? "" })
              : x.madeBy
                ? t("sec.owner.venueMadeBy", { name: x.madeBy })
                : t("sec.owner.venue");
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">{t("int.title")}</h2>
        {venues.length > 1 && (
          <select value={venueId} onChange={(e) => setVenueId(Number(e.target.value))} aria-label={t("c.venue")} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {/* The code samples are requests and headers as typed, the same in every language. */}
        {withParts(t("int.apiIntro"), {
          url: <code className="rounded bg-slate-100 px-1">{origin}/api/v1</code>,
          header: <code className="rounded bg-slate-100 px-1">Authorization: Bearer &lt;key&gt;</code>, // staff-i18n-ignore
          venue: <code>GET /venue</code>, // staff-i18n-ignore
          availability: <code>GET /availability?date=</code>, // staff-i18n-ignore
          bookings: <code>GET /bookings?from=&amp;to=</code>, // staff-i18n-ignore
          booking: <code>GET /bookings/&lt;code&gt;</code>, // staff-i18n-ignore
          book: <code>POST /bookings</code>, // staff-i18n-ignore
          cancel: <code>POST /bookings/&lt;code&gt;/cancel</code>, // staff-i18n-ignore
        })}
      </p>
      <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{t("int.keyWarning")}</div>
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      {notice && <p className="mt-2 text-sm text-emerald-700">{notice}</p>}
      {shown && (
        <div className="mt-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm">
          <p className="font-semibold">{t("int.copyNow", { label: shown.label })}</p>
          <p className="mt-1 break-all font-mono text-xs">{shown.value}</p>
          <div className="mt-1 flex gap-3">
            <button type="button" className="font-medium text-teal-700 underline" onClick={() => void navigator.clipboard?.writeText(shown.value)}>
              {t("c.copy")}
            </button>
            <button type="button" className="font-medium text-slate-600 underline" onClick={() => setShown(null)}>
              {t("int.done")}
            </button>
          </div>
        </div>
      )}

      <h3 className="mt-4 font-semibold">{t("int.keys")}</h3>
      <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
        {keys.length === 0 && <li className="p-2 text-slate-500">{t("int.noneYet")}</li>}
        {keys.map((k) => (
          <li key={k.id} className={`flex flex-wrap items-center justify-between gap-2 p-2 ${k.revokedAt ? "text-slate-400" : ""}`}>
            <span>
              <span className="font-medium">{k.name}</span> · <code>{k.prefix}…</code> · {k.scope === "write" ? t("int.scopeWrite") : k.scope === "availability" ? t("int.scopeAvailability") : t("int.scopeRead")}
              <span className="block text-xs text-slate-500">
                {k.revokedAt
                  ? t("int.revokedOn", { date: clock.day(k.revokedAt, venueId) })
                  : k.lastUsedAt
                    ? t("int.lastUsed", { date: clock.when(k.lastUsedAt, venueId) })
                    : t("int.notUsedYet")}
              </span>
              <span className={`block text-xs ${k.ownerLost || k.revokedReason ? "text-amber-700" : "text-slate-500"}`}>{whose(k, k.revokedReason)}</span>
            </span>
            {!k.revokedAt && (
              <span className="flex gap-3">
                {!k.ownerLost &&
                  (k.ownership === "venue" ? (
                    <button type="button" className="font-medium text-teal-700 underline" onClick={() => void act({ action: "handOver", kind: "key", id: k.id, to: me })}>
                      {t("sec.hand.toMe")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="font-medium text-teal-700 underline"
                      onClick={() => {
                        if (window.confirm(t("sec.hand.confirmVenue", { name: k.name, owner: k.ownerName ?? "" }))) void act({ action: "handOver", kind: "key", id: k.id, to: "venue" });
                      }}
                    >
                      {t("sec.hand.toVenue")}
                    </button>
                  ))}
                <button
                  type="button"
                  className="font-medium text-teal-700 underline"
                  onClick={async () => {
                    if (!window.confirm(t("sec.rotateKeyConfirm", { name: k.name }))) return;
                    const d = await act({ action: "rotate", kind: "key", id: k.id });
                    if (d) setShown({ label: t("int.apiKeyLabel", { name: d.record.name }), value: d.key });
                  }}
                >
                  {t("sec.rotate")}
                </button>
                <button
                  type="button"
                  className="font-medium text-rose-700 underline"
                  onClick={() => {
                    if (window.confirm(t("int.revokeConfirm", { name: k.name }))) void act({ action: "revoke", id: k.id });
                  }}
                >
                  {t("int.revoke")}
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <input className={input} placeholder={t("int.keyNamePlaceholder")} value={keyForm.name} onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })} aria-label={t("int.keyName")} />
        <select className={input} value={keyForm.scope} onChange={(e) => setKeyForm({ ...keyForm, scope: e.target.value })} aria-label={t("int.keyScope")}>
          <option value="availability">{t("int.optionAvailability")}</option>
          <option value="read">{t("int.optionRead")}</option>
          <option value="write">{t("int.optionWrite")}</option>
        </select>
        <button
          type="button"
          className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white"
          onClick={async () => {
            const d = await act({ action: "key", name: keyForm.name, scope: keyForm.scope, ownership: keyForm.venueOwned ? "venue" : "person" });
            if (d) {
              setShown({ label: t("int.apiKeyLabel", { name: d.record.name }), value: d.key });
              setKeyForm({ name: "", scope: "read", venueOwned: false });
            }
          }}
        >
          {t("int.makeKey")}
        </button>
        <label className="flex basis-full items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={keyForm.venueOwned} onChange={(e) => setKeyForm({ ...keyForm, venueOwned: e.target.checked })} />
          {t("sec.venueOwnedCheck")}
        </label>
      </div>

      <h3 className="mt-4 font-semibold">{t("int.webhooks")}</h3>
      <p className="text-xs text-slate-500">
        {withParts(t("int.webhooksIntro"), {
          created: <code>booking.created</code>,
          cancelled: <code>booking.cancelled</code>,
          paid: <code>booking.paid</code>,
          changed: <code>booking.changed</code>,
          header: <code>MySenam-Signature</code>, // staff-i18n-ignore
        })}
      </p>
      <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
        {endpoints.length === 0 && <li className="p-2 text-slate-500">{t("int.noneYet")}</li>}
        {endpoints.map((e) => (
          <li key={e.id} className="p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-all">
                <span className="font-medium">{e.url}</span>{" "}
                <span className={`text-xs ${e.active ? (e.failingSince ? "text-amber-700" : "text-emerald-700") : "text-rose-700"}`}>
                  {e.active ? (e.failingSince ? t("int.failingSince", { date: clock.when(e.failingSince, venueId) }) : t("int.on")) : t("int.turnedOff")}
                </span>
                <span className={`block text-xs ${e.ownerLost || e.stoppedReason ? "text-amber-700" : "text-slate-500"}`}>{whose(e, e.stoppedReason)}</span>
              </span>
              <span className="flex gap-3">
                {e.active ? (
                  <button type="button" className="font-medium text-teal-700 underline" onClick={() => void act({ action: "ping", id: e.id })}>
                    {t("int.sendTest")}
                  </button>
                ) : (
                  !e.ownerLost && (
                    <button type="button" className="font-medium text-teal-700 underline" onClick={() => void act({ action: "resume", id: e.id })}>
                      {t("int.turnBackOn")}
                    </button>
                  )
                )}
                {!e.ownerLost &&
                  (e.ownership === "venue" ? (
                    <button type="button" className="font-medium text-teal-700 underline" onClick={() => void act({ action: "handOver", kind: "webhook", id: e.id, to: me })}>
                      {t("sec.hand.toMe")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="font-medium text-teal-700 underline"
                      onClick={() => {
                        if (window.confirm(t("sec.hand.confirmVenue", { name: e.url, owner: e.ownerName ?? "" }))) void act({ action: "handOver", kind: "webhook", id: e.id, to: "venue" });
                      }}
                    >
                      {t("sec.hand.toVenue")}
                    </button>
                  ))}
                <button
                  type="button"
                  className="font-medium text-teal-700 underline"
                  onClick={async () => {
                    if (!window.confirm(t("sec.rotateHookConfirm", { name: e.url }))) return;
                    const d = await act({ action: "rotate", kind: "webhook", id: e.id });
                    if (d) setShown({ label: t("int.signingSecret"), value: d.secret });
                  }}
                >
                  {t("sec.rotate")}
                </button>
                <button type="button" className="font-medium text-rose-700 underline" onClick={() => void act({ action: "remove", id: e.id })}>
                  {t("c.remove")}
                </button>
              </span>
            </div>
            {e.failedCount > 0 && (
              <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">
                    {t("whd.title")}: {t("whd.count", { n: e.failedCount })}
                  </span>
                  {e.active ? (
                    <button
                      type="button"
                      className="font-medium text-teal-700 underline"
                      onClick={() => {
                        if (window.confirm(t("whd.confirmAll", { n: Math.min(e.failedCount, retry.most), url: e.url }))) void sendAgain({ id: e.id });
                      }}
                    >
                      {t("whd.sendAllAgain")}
                    </button>
                  ) : (
                    <span>{t("whd.turnOnFirst")}</span>
                  )}
                </div>
                <p className="mt-1">{t("whd.intro", { tries: retry.tries, days: retry.days })}</p>
                <ul className="mt-1 space-y-1">
                  {e.failed.slice(0, 5).map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {clock.when(d.createdAt, venueId)} {d.event}: {t("int.triedTimes", { error: d.lastError ?? String(d.lastStatus ?? ""), n: d.attempts })}
                        {d.lastAttemptAt ? `, ${t("whd.lastTried", { date: clock.when(d.lastAttemptAt, venueId) })}` : ""}
                        {d.eventId ? ` · ${t("whd.eventId", { id: d.eventId })}` : ""}
                        {d.redeliveries > 0 && d.redeliveredAt ? ` · ${t("whd.resent", { n: d.redeliveries, date: clock.when(d.redeliveredAt, venueId) })}` : ""}
                      </span>
                      {e.active && (
                        <button type="button" className="font-medium text-teal-700 underline" onClick={() => void sendAgain({ deliveryId: d.id })}>
                          {t("whd.sendAgain")}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {e.failedCount > Math.min(e.failed.length, 5) && <p className="mt-1">{t("whd.more", { n: e.failedCount - Math.min(e.failed.length, 5) })}</p>}
              </div>
            )}
            {e.recent.length > 0 && (
              <ul className="mt-1 text-xs text-slate-500">
                {e.recent.slice(0, 5).map((d, i) => (
                  <li key={i}>
                    {clock.when(d.at, venueId)} {d.event}:{" "}
                    {d.deliveredAt
                      ? t("int.delivered", { status: String(d.status) })
                      : d.error
                        ? t("int.triedTimes", { error: d.error, n: d.attempts })
                        : t("int.waiting")}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <input className={`${input} min-w-[18rem]`} placeholder="https://example.com/mysenam-hook" value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t("int.webhookAddress")} />
        <button
          type="button"
          className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white"
          onClick={async () => {
            const d = await act({ action: "webhook", url, ownership: hookVenueOwned ? "venue" : "person" });
            if (d) {
              setShown({ label: t("int.signingSecret"), value: d.secret });
              setUrl("");
              setHookVenueOwned(false);
            }
          }}
        >
          {t("int.addAddress")}
        </button>
        <label className="flex basis-full items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={hookVenueOwned} onChange={(e) => setHookVenueOwned(e.target.checked)} />
          {t("sec.venueOwnedCheck")}
        </label>
      </div>

      <h3 className="mt-4 font-semibold">{t("int.google")}</h3>
      <label className="mt-1 flex items-start gap-2 text-sm">
        <input type="checkbox" checked={google} onChange={(e) => void act({ action: "google", on: e.target.checked })} className="mt-1" />
        <span>{t("int.googleInclude")}</span>
      </label>
      {isOwner && (
        <p className="mt-1 text-xs text-slate-500">
          {t("int.feeds")}{" "}
          {(["merchants", "services", "availability"] as const).map((f) => (
            <a key={f} href={`/api/admin/google-feeds?feed=${f}`} className="mr-2 font-medium text-teal-700 underline">
              {f}.json
            </a>
          ))}
        </p>
      )}

      <McpSection origin={origin} />

      <h3 className="mt-4 font-semibold">{t("int.aiData")}</h3>
      <p className="mt-1 text-sm text-slate-600">
        <span aria-hidden>{ai.on ? "● " : "○ "}</span>
        {ai.on ? t("int.aiDataOn") : t("int.aiDataOff")}
      </p>
      <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{t("int.aiDataWarning")}</div>
      <label className="mt-2 flex min-h-6 items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={ai.on}
          onChange={(e) => {
            const on = e.target.checked;
            // Turning it on is said plainly first; turning it off needs no warning.
            if (on && !window.confirm(t("int.aiDataConfirm"))) return;
            void act({ action: "aiPersonalData", on });
          }}
          className="mt-1"
        />
        <span>{t("int.aiDataToggle")}</span>
      </label>
      {ai.changedAt && ai.changedBy && <p className="mt-1 text-xs text-slate-500">{t("int.aiDataChanged", { name: ai.changedBy, date: clock.when(ai.changedAt, venueId) })}</p>}
    </section>
  );
}

/**
 * How to add the MCP server to an AI assistant (docs/integrations/mcp.md#connecting):
 * its address and an example per assistant, each reading the key from an
 * environment variable, never from the chat.
 */
function McpSection({ origin }: { origin: string }) {
  const t = useStaffT();
  const url = `${origin}/api/mcp`;
  // Commands and configuration as typed, the same in every language.
  const examples: { label: string; code: string }[] = [
    { label: t("int.mcpClaudeCode"), code: `claude mcp add --transport http mysenam ${url} --header "Authorization: Bearer $MYSENAM_API_KEY"` }, // staff-i18n-ignore
    {
      label: t("int.mcpCursor"),
      code: JSON.stringify({ mcpServers: { mysenam: { url, headers: { Authorization: "Bearer ${env:MYSENAM_API_KEY}" } } } }, null, 2), // staff-i18n-ignore
    },
    {
      label: t("int.mcpDesktop"),
      code: JSON.stringify(
        // staff-i18n-ignore
        { mcpServers: { mysenam: { command: "npx", args: ["-y", "mcp-remote", url, "--header", "Authorization:${MYSENAM_AUTH}"], env: { MYSENAM_AUTH: "Bearer <key>" } } } }, // staff-i18n-ignore
        null,
        2
      ),
    },
  ];
  return (
    <>
      <h3 className="mt-4 font-semibold">{t("int.mcp")}</h3>
      <p className="mt-1 text-sm text-slate-600">{withParts(t("int.mcpIntro"), { url: <code className="rounded bg-slate-100 px-1">{url}</code> })}</p>
      <p className="mt-1 text-sm text-slate-600">{withParts(t("oa.connector"), { url: <code className="rounded bg-slate-100 px-1">{`${origin}/api/mcp/staff`}</code> })}</p>
      <p className="mt-1 text-sm text-slate-600">{t("int.mcpKey")}</p>
      {examples.map((e) => (
        <div key={e.label} className="mt-2">
          <p className="m-0 text-xs font-medium text-slate-700">{e.label}</p>
          <pre className="mt-1 overflow-x-auto rounded bg-slate-100 p-2 text-xs">{e.code}</pre>
        </div>
      ))}
      <p className="mt-1 text-xs text-slate-500">{t("int.mcpUntested")}</p>
    </>
  );
}
