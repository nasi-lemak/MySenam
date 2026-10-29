"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import type { StaffText } from "@/lib/staff-text";
import { useStaffT } from "./StaffLanguage";
import { ManagerOnly, useStaffMay } from "./StaffMay";
import { formatHour } from "@/lib/time";

interface GoLiveStatus {
  state: "draft" | "live" | "unlisted";
  suspension: { by: "payment" | "owner"; reason: string | null } | null;
  request: { status: "draft" | "pending" | "approved" | "rejected"; reason: string | null } | null;
  missing: string[];
  missingPhrases?: StaffText[];
}

/**
 * Whether customers can see this venue, and what to do if not.
 *
 * A draft says so, says what it still needs, and sends itself to the
 * platform owner when it is ready. It stays until the venue is live — unlike
 * the setup checklist, it cannot be hidden, because a business that never
 * finds this button never goes live.
 */
export function GoLiveBanner({
  venueId,
  venueName,
  refreshKey,
  onChange,
  live = false,
}: {
  venueId: number;
  /** Shown when there is more than one branch. */
  venueName?: string | null;
  refreshKey: string;
  onChange: () => void;
  /** Live and listed: only its test bookings left over from setting up, if any, are shown. */
  live?: boolean;
}) {
  const t = useStaffT();
  // Asking to go live is a manager's (lib/roles.ts): front desk sees where the branch stands, without the button.
  const may = useStaffMay();
  const [status, setStatus] = useState<GoLiveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped when something is saved under Venue details ("setup:refresh"): a pin put down is no longer missing.
  const [saved, setSaved] = useState(0);
  // Test bookings made before going live (lib/test-bookings.ts), and whether to clear them as it is sent.
  const [tests, setTests] = useState<TestBooking[]>([]);
  const [clearOnSend, setClearOnSend] = useState(false);
  const [testsChanged, setTestsChanged] = useState(0);
  // Whether real money was taken on them, asked where a counter payment is on one (lib/test-bookings.ts); no default.
  const [moneyTaken, setMoneyTaken] = useState<MoneyAnswer>("");
  const asks = tests.some((b) => b.counterPaid === true);
  const clearing = clearOnSend && tests.length > 0;

  useEffect(() => {
    const bump = () => setSaved((n) => n + 1);
    window.addEventListener("setup:refresh", bump);
    return () => window.removeEventListener("setup:refresh", bump);
  }, []);

  useEffect(() => {
    if (live) return setStatus({ state: "live", suspension: null, request: null, missing: [] });
    fetch(`/api/admin/go-live?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => (r.ok ? readJson(r) : null))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [venueId, refreshKey, saved, live]);

  // A live venue's are read once (and after clearing or keeping), not on every change of tab.
  const testsKey = live ? "" : refreshKey;
  useEffect(() => {
    fetch(`/api/admin/test-bookings?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => (r.ok ? readJson(r) : null))
      .then((d: { bookings?: TestBooking[] } | null) => setTests(d?.bookings ?? []))
      .catch(() => setTests([]));
  }, [venueId, testsKey, testsChanged]);

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/go-live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...(clearing ? { clearTests: true, ...(asks && moneyTaken ? { moneyTaken } : {}) } : {}) }),
      });
      const data = await readJson(res);
      // Cleared before it was refused (kit still out): the list has changed.
      if (data.cleared) setTestsChanged((n) => n + 1);
      if (!res.ok) throw new Error(t.err(data, t("live.couldNotSend")));
      setStatus(data.status);
      if (data.cleared) setTestsChanged((n) => n + 1);
      if (data.live) onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("live.couldNotSend"));
    } finally {
      setBusy(false);
    }
  }

  const testPanel = (
    <TestBookingsPanel venueId={venueId} bookings={tests} onDone={() => setTestsChanged((n) => n + 1)} />
  );
  if (!status) return null;
  if (status.state === "live") return tests.length > 0 ? testPanel : null;
  const name = venueName ?? t("live.yourVenue");

  if (status.state === "unlisted" && status.suspension?.by === "owner")
    return (
      <section className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        <p className="font-semibold">{t("live.suspended", { name })}</p>
        <p className="mt-1">
          {status.suspension.reason ? `${status.suspension.reason}. ` : ""}
          {t("live.suspendedBody")}
        </p>
      </section>
    );

  if (status.state === "unlisted")
    return (
      <section className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        <p className="font-semibold">{t("live.unlisted", { name })}</p>
        <p className="mt-1">
          {t("live.unlistedBody")}
        </p>
      </section>
    );

  const waiting = status.request?.status === "pending";
  const turnedDown = status.request?.status === "rejected";
  return (
    <>
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">
            {waiting ? t("live.waiting", { name }) : t("live.draft", { name })}
          </p>
          {waiting ? (
            <p className="mt-1">{t("live.waitingBody")}</p>
          ) : turnedDown ? (
            <p className="mt-1">
              {status.request?.reason ? t("live.rejectedReason", { reason: status.request.reason }) : t("live.rejected")}
            </p>
          ) : (
            <p className="mt-1">
              {t("live.draftBody")}
            </p>
          )}
          {!waiting && status.missing.length > 0 && (
            <ul className="mt-2 list-inside list-disc">
              {status.missing.map((m, i) => (
                <li key={m}>{t.say(status.missingPhrases?.[i], m)}</li>
              ))}
            </ul>
          )}
          {error && <p className="mt-2 font-medium text-red-700">{error}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a href={`/venue/${venueId}`} target="_blank" rel="noopener" className="underline">
            {t("live.seePage")}
          </a>
          {!waiting && may("goLive") && tests.length > 0 && (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={clearOnSend} onChange={(e) => setClearOnSend(e.target.checked)} />
              {t.plural("r9c.test.clearOnSend", tests.length)}
            </label>
          )}
          {!waiting && may("goLive") && clearing && asks && <MoneyQuestion id="send" value={moneyTaken} onChange={setMoneyTaken} />}
          {!waiting && may("goLive") && (
            <button
              onClick={ask}
              disabled={busy || status.missing.length > 0 || (clearing && asks && !moneyTaken)}
              className="rounded-lg bg-teal-600 px-3 py-1.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {turnedDown ? t("live.askAgain") : t("live.ask")}
            </button>
          )}
        </div>
      </div>
    </section>
    {tests.length > 0 && testPanel}
    </>
  );
}

interface TestBooking {
  code: string;
  date: string;
  startHour: number;
  endHour: number;
  courtName: string;
  name: string;
  /** A counter payment is on it: clearing it asks whether real money was taken. */
  counterPaid?: boolean;
}

type MoneyAnswer = "none" | "real" | "";

/**
 * Whether real money was taken on the test bookings being cleared (lib/test-bookings.ts): asked only where a counter
 * payment is on one, with no answer chosen for the manager; recorded with their name.
 */
function MoneyQuestion({ id, value, onChange }: { id: string; value: MoneyAnswer; onChange: (v: "none" | "real") => void }) {
  const t = useStaffT();
  return (
    <fieldset className="w-full space-y-1 text-sm">
      <legend className="font-medium">{t("r10a.test.ask")}</legend>
      {(["none", "real"] as const).map((v) => (
        <label key={v} className="flex items-start gap-1.5">
          <input type="radio" name={`money-taken-${id}`} value={v} checked={value === v} onChange={() => onChange(v)} />
          <span>{t(v === "none" ? "r10a.test.none" : "r10a.test.real")}</span>
        </label>
      ))}
      <p className="text-xs">{t("r10a.test.recorded")}</p>
    </fieldset>
  );
}

/**
 * The venue's test bookings still standing, made before it went live
 * (lib/test-bookings.ts): what they are kept out of, and a manager's way to
 * clear them all or keep one as a real booking. Shown until none is left,
 * after going live too.
 */
function TestBookingsPanel({ venueId, bookings, onDone }: { venueId: number; bookings: TestBooking[]; onDone: () => void }) {
  const t = useStaffT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const may = useStaffMay();
  const [moneyTaken, setMoneyTaken] = useState<MoneyAnswer>("");
  const asks = bookings.some((b) => b.counterPaid === true);

  async function post(action: "clear" | "keep", codes?: string[]) {
    if (action === "clear" && !window.confirm(t.plural("r9c.test.confirm", bookings.length))) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/test-bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, action, ...(codes ? { codes } : {}), ...(action === "clear" && asks && moneyTaken ? { moneyTaken } : {}) }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("r9c.test.failed")));
      const refused = (data.refused ?? []) as { code: string; error: string }[];
      const done = (data.done ?? []) as string[];
      setMessage(
        [
          action === "clear" ? t.plural("r9c.test.cleared", done.length) : done.length > 0 ? t("r9c.test.kept") : "",
          action === "clear" && asks && moneyTaken === "real" && done.length > 0 ? t("r10a.test.owedNote") : "",
          refused.length ? t("r9c.test.notDone", { list: refused.map((r) => `${r.code}: ${t.err(r.error)}`).join("; ") }) : "",
        ]
          .filter(Boolean)
          .join(" ")
      );
      onDone();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("r9c.test.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-300 bg-slate-50 p-4 text-sm text-slate-800">
      <p className="font-semibold">{t.plural("r9c.test.title", bookings.length)}</p>
      <p className="mt-1">{t("r9c.test.body")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setOpen(!open)} className="underline">
          {open ? t("r9c.test.hide") : t("r9c.test.show")}
        </button>
        <ManagerOnly may="testBookings" note={false}>
          <button
            type="button"
            onClick={() => void post("clear")}
            disabled={busy || (asks && !moneyTaken)}
            className="rounded-lg border border-red-300 px-3 py-1.5 font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {t("r9c.test.clearAll")}
          </button>
        </ManagerOnly>
      </div>
      {may("testBookings") && asks && <div className="mt-2"><MoneyQuestion id="panel" value={moneyTaken} onChange={setMoneyTaken} /></div>}
      {message && <p className="mt-2 font-medium">{message}</p>}
      {open && (
        <ul className="mt-2 space-y-1">
          {bookings.map((b) => (
            <li key={b.code} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{b.code}</span>
              <span>
                {b.date} {formatHour(b.startHour, t.locale)} – {formatHour(b.endHour, t.locale)} · {b.courtName} · {b.name}
              </span>
              <ManagerOnly may="testBookings" note={false}>
                <button type="button" onClick={() => void post("keep", [b.code])} disabled={busy} className="text-xs underline">
                  {t("r9c.test.keep")}
                </button>
              </ManagerOnly>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
