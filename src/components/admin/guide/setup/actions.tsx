"use client";

import { useEffect, useState, type ComponentType } from "react";
import { ClockField } from "@/components/ClockField";
import { readJson } from "@/lib/read-response";
import { formatMinute } from "@/lib/interval";
import type { PlanItem, SetupAction } from "@/lib/guide/plan";
import { hasHistory } from "@/lib/guide/profile-types";
import type { JourneyView } from "@/lib/guide/setup-journey";
import type { DashboardTab } from "@/lib/guide/shell";
import type { WeekHours } from "@/lib/week-hours";
import { money } from "@/lib/region";
import { AddResourcesForm } from "../../ResourcesEditor";
import { BookingPolicyEditor } from "../../BookingPolicyEditor";
import { CancelPolicyEditor } from "../../CancelPolicyEditor";
import { CourtChangesFromDate, HoursFromDate, strandedText } from "../../DatedChanges";
import { PeakHoursEditor } from "../../PeakHoursEditor";
import { useStaffT } from "../../StaffLanguage";
import { SetupReadiness } from "../SetupReadiness";
import { SetupTryIt } from "../SetupTryIt";
import { friendlyDate } from "./say";

/**
 * The existing editors and routes the setup journey runs inside its steps
 * (docs/features/venue-guide.md#the-setup-journey; ADR 0028). Nothing here
 * has a setting of its own: each action is either an existing component of
 * the dashboard (resources, booking rules, peak hours, hours and rates from a
 * date, the cancellation terms) or a request to the existing route (venue
 * hours, a court's rates, a staff invitation), so the same validation,
 * permission, log entry and effective-dating apply, and the application's own
 * refusals are shown in its own words. After any save, `onChanged` re-reads
 * the venue's saved state and the setup checklist and go-live banner tick off
 * what was saved.
 */

export interface ActionProps {
  venueId: number;
  view: JourneyView;
  item: PlanItem;
  /** Something was saved: read the saved state again. */
  onChanged: () => void;
  onGo: (tab: DashboardTab) => void;
  /** Move the journey to another step. */
  onStep: (id: string) => void;
}

const inputClass = "min-h-9 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none";
const primary = "min-h-9 rounded-md bg-teal-600 px-3 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50";
const secondary = "min-h-9 rounded-md border border-slate-300 px-3 text-sm font-medium hover:border-teal-400 disabled:opacity-50";

/** The checklist at the top of the dashboard and the go-live banner listen for this (VenuesTab sends it too). */
const refreshDashboard = () => window.dispatchEvent(new Event("setup:refresh"));

function Message({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}
    </>
  );
}

/** What one hour on the example Saturday costs, from the real pricing function: shown beside the choice that changes it. */
function PriceExample({ view, onRefresh }: { view: JourneyView; onRefresh?: () => void }) {
  const t = useStaffT();
  const { prices } = view.extras;
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" data-price-example>
      <p className="font-medium">{t("gs.act.example.title")}</p>
      {prices.length === 0 ? (
        <p className="text-slate-600">{t("gs.act.example.none")}</p>
      ) : (
        <ul className="mt-1 list-disc pl-5 text-slate-700">
          {prices.map((p) => (
            <li key={p.courtId}>
              {t(p.peak ? "gs.try.price.rowPeak" : "gs.try.price.row", { court: p.court, date: friendlyDate(p.date, t.locale), time: formatMinute(p.startMin, t.locale), amount: money(p.total) })}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-xs text-slate-500">{t("gs.act.example.note")}</p>
      {onRefresh && (
        <button type="button" onClick={onRefresh} className="mt-1 min-h-8 text-xs underline hover:text-teal-700">
          {t("gs.act.example.refresh")}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- hours and details

/** The venue's usual opening hours: `PATCH /api/admin/venues/:id` as the Venue details screen sends it, and the checklist's own "they are right as they are". */
function HoursAction({ venueId, view, onChanged, onGo }: ActionProps) {
  const t = useStaffT();
  const venue = view.extras.venue;
  const [openMin, setOpenMin] = useState(venue.openMin);
  const [closeMin, setCloseMin] = useState(venue.closeMin);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setOpenMin(venue.openMin);
    setCloseMin(venue.closeMin);
  }, [venue.openMin, venue.closeMin]);
  const changed = openMin !== venue.openMin || closeMin !== venue.closeMin;
  const own = Array.isArray(venue.weekHours) && (venue.weekHours as unknown[]).some((d) => d !== null);

  async function send(url: string, method: string, body: unknown, ok: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await readJson(res);
      // Hours that would leave bookings outside them name every one (lib/dated-changes.ts), as the application words it.
      if (!res.ok) throw new Error(t.err(data, t("gd.failed")) + strandedText(data, t));
      setNotice(ok);
      refreshDashboard();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gd.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs font-medium text-slate-600">
          {t("vn.opens")}
          <ClockField label={t("vn.opens")} value={openMin} onChange={setOpenMin} className={`mt-1 w-32 ${inputClass}`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-600">
          {t("vn.closes")}
          <ClockField label={t("vn.closes")} value={closeMin} after={openMin} onChange={setCloseMin} className={`mt-1 w-32 ${inputClass}`} />
        </label>
        <button type="button" disabled={busy || !changed} onClick={() => void send(`/api/admin/venues/${venueId}`, "PATCH", { openMin, closeMin }, t("gs.act.hours.saved"))} className={primary}>
          {t("c.save")}
        </button>
        <button type="button" disabled={busy} onClick={() => void send("/api/admin/setup", "POST", { venueId, action: "detailsChecked" }, t("gs.act.hours.confirmed"))} className={secondary}>
          {t("set.hoursRight")}
        </button>
      </div>
      <p className="text-xs text-slate-600">{t("gs.act.hours.today", { from: formatMinute(venue.openMin, t.locale), to: formatMinute(venue.closeMin, t.locale) })}</p>
      {own && <p className="text-xs text-slate-600">{t("gs.act.hours.own")}</p>}
      <p className="text-xs">
        <button type="button" onClick={() => onGo("venues")} className="min-h-8 underline hover:text-teal-700">
          {t("gs.act.hours.details")}
        </button>
      </p>
      <Message error={error} notice={notice} />
      <details className="rounded-md border border-slate-200 px-3 py-2">
        <summary className="min-h-8 cursor-pointer text-sm font-medium">{t("gs.act.hours.fromDate")}</summary>
        <div className="mt-2">
          <HoursFromDate venueId={venueId} current={{ openMin: venue.openMin, closeMin: venue.closeMin, weekHours: (venue.weekHours ?? null) as WeekHours | null }} />
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------- resources

/** Add courts or other resources from an activity's template: the existing form, `POST /api/admin/courts`. */
function ResourcesAction({ venueId, view, onChanged }: ActionProps) {
  const t = useStaffT();
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">{t("gs.act.resources.have", { n: view.profile.resources.total })}</p>
      <Message error={null} notice={notice} />
      <AddResourcesForm
        venueId={venueId}
        onAdded={(message) => {
          setNotice(message);
          refreshDashboard();
          onChanged();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- prices

/**
 * Each court's off-peak and peak rate: `PATCH /api/admin/courts/:id`, the
 * rates table's own request, which changes what new bookings cost from now. A
 * venue with bookings sees them read-only and is sent to *from a date*, so a
 * rerun never changes a price by accident.
 */
function PricesAction({ view, onChanged, onStep }: ActionProps) {
  const t = useStaffT();
  const locked = hasHistory(view.profile);
  const priced = view.extras.courts.filter((c) => !c.classesOnly);
  const [rates, setRates] = useState<Record<number, { off: string; peak: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = (id: number) => rates[id] ?? { off: String(priced.find((c) => c.id === id)?.offPeakRate ?? ""), peak: String(priced.find((c) => c.id === id)?.peakRate ?? "") };

  async function save(id: number) {
    const value = current(id);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/courts/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offPeakRate: Number(value.off), peakRate: Number(value.peak) }) });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("gd.failed")));
      setNotice(t("gs.act.prices.saved"));
      setRates((r) => {
        const { [id]: _gone, ...rest } = r;
        return rest;
      });
      refreshDashboard();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gd.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {locked && (
        <p role="note" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t("gs.act.prices.locked")}{" "}
          <button type="button" onClick={() => onStep("price-dates")} className="underline">
            {t("gs.act.prices.toDates")}
          </button>
        </p>
      )}
      <ul className="space-y-2">
        {priced.slice(0, 12).map((c) => (
          <li key={c.id} className="flex flex-wrap items-end gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" data-court={c.id}>
            <span className="min-w-28 font-medium">{c.name}</span>
            <label className="flex flex-col text-xs font-medium text-slate-600">
              {t("res.offPeakRate")}
              <input
                type="number"
                min={0}
                step={0.01}
                disabled={locked}
                aria-label={t("gs.act.prices.offPeakOf", { court: c.name })}
                value={current(c.id).off}
                onChange={(e) => setRates({ ...rates, [c.id]: { ...current(c.id), off: e.target.value } })}
                className={`mt-1 w-24 ${inputClass}`}
              />
            </label>
            <label className="flex flex-col text-xs font-medium text-slate-600">
              {t("res.peakRate")}
              <input
                type="number"
                min={0}
                step={0.01}
                disabled={locked}
                aria-label={t("gs.act.prices.peakOf", { court: c.name })}
                value={current(c.id).peak}
                onChange={(e) => setRates({ ...rates, [c.id]: { ...current(c.id), peak: e.target.value } })}
                className={`mt-1 w-24 ${inputClass}`}
              />
            </label>
            {!locked && (
              <button type="button" disabled={busy || rates[c.id] === undefined} onClick={() => void save(c.id)} className={primary}>
                {t("c.save")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {priced.length > 12 && <p className="text-xs text-slate-600">{t("gs.act.prices.more", { n: priced.length - 12 })}</p>}
      <Message error={error} notice={notice} />
      <PriceExample view={view} />
    </div>
  );
}

/** When peak rates apply, and holidays: the existing editor, `POST /api/admin/peak-rules` and `/holidays`. */
function PeakHoursAction({ venueId, view, onChanged }: ActionProps) {
  return (
    <div className="space-y-3">
      <PeakHoursEditor venueId={venueId} />
      <PriceExample view={view} onRefresh={onChanged} />
    </div>
  );
}

/** Hours and rates from a later date: the existing forms (ADR 0027), which list what waits and refuse what would strand a booking. */
function PriceDatesAction({ venueId, view }: ActionProps) {
  const t = useStaffT();
  const venue = view.extras.venue;
  return (
    <div className="space-y-3">
      <details className="rounded-md border border-slate-200 px-3 py-2" open>
        <summary className="min-h-8 cursor-pointer text-sm font-medium">{t("gs.act.dates.rates")}</summary>
        <div className="mt-2">{view.extras.courts.length > 0 ? <CourtChangesFromDate venueId={venueId} courts={view.extras.courts} /> : <p className="text-sm text-slate-600">{t("gs.act.dates.noCourts")}</p>}</div>
      </details>
      <details className="rounded-md border border-slate-200 px-3 py-2">
        <summary className="min-h-8 cursor-pointer text-sm font-medium">{t("gs.act.hours.fromDate")}</summary>
        <div className="mt-2">
          <HoursFromDate venueId={venueId} current={{ openMin: venue.openMin, closeMin: venue.closeMin, weekHours: (venue.weekHours ?? null) as WeekHours | null }} />
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------- booking rules

/** What a cleaning gap after a booking does to the next time offered: arithmetic from the booking time model, shown with the numbers the manager types. */
function BufferExample() {
  const t = useStaffT();
  const [after, setAfter] = useState("10");
  const minutes = Math.max(0, Math.min(240, Number(after) || 0));
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" data-buffer-example>
      <label className="flex flex-wrap items-center gap-2">
        {t("gs.act.buffer.label")}
        <input type="number" min={0} max={240} value={after} onChange={(e) => setAfter(e.target.value)} className={`w-20 ${inputClass}`} />
      </label>
      <p className="mt-1 text-slate-700">{t("gs.act.buffer.result", { end: formatMinute(19 * 60, t.locale), next: formatMinute(19 * 60 + minutes, t.locale), start: formatMinute(18 * 60, t.locale), n: minutes })}</p>
      <p className="text-xs text-slate-500">{t("gs.act.buffer.note")}</p>
    </div>
  );
}

/** Starts, lengths and buffers: the existing editor, `POST /api/admin/booking-policies`. */
function BookingRulesAction({ venueId, view }: ActionProps) {
  return (
    <div className="space-y-3">
      <BufferExample />
      <BookingPolicyEditor venueId={venueId} courts={view.extras.courts} />
    </div>
  );
}

// ---------------------------------------------------------------- cancellation

/** The venue's terms as they stand, the cutoff (`PATCH /api/admin/venues/:id`), and the late-cancellation, refund and strike terms: the existing editor. */
function CancellationAction({ venueId, view, onChanged }: ActionProps) {
  const t = useStaffT();
  const terms = view.profile.policies.cancellation;
  const [cutoff, setCutoff] = useState(String(view.extras.venue.cancelCutoffHours));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setCutoff(String(view.extras.venue.cancelCutoffHours)), [view.extras.venue.cancelCutoffHours]);

  async function saveCutoff() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/venues/${venueId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cancelCutoffHours: Number(cutoff) }) });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("gd.failed")));
      setNotice(t("gs.act.cancel.cutoffSaved"));
      refreshDashboard();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gd.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" data-terms>
        {t("gs.act.cancel.now", {
          hours: terms.cutoffHours,
          keep: terms.lateKeepPercent === null ? t("gs.try.cancel.keepNone") : t("gs.try.cancel.keepSome", { percent: terms.lateKeepPercent }),
        })}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs font-medium text-slate-600">
          {t("vn.cutoff")}
          <input type="number" min={0} max={72} value={cutoff} onChange={(e) => setCutoff(e.target.value)} className={`mt-1 w-24 ${inputClass}`} />
        </label>
        <button type="button" disabled={busy || Number(cutoff) === view.extras.venue.cancelCutoffHours} onClick={() => void saveCutoff()} className={primary}>
          {t("c.save")}
        </button>
      </div>
      <Message error={error} notice={notice} />
      <CancelPolicyEditor venueId={venueId} />
    </div>
  );
}

// ---------------------------------------------------------------- staff

interface StaffOptions {
  invitations: boolean;
  typedPassword: boolean;
}

/** Invite staff: `POST /api/admin/admins`, the Venue details screen's own request (an emailed invitation to choose their own password; a typed password only where this install cannot email). */
function StaffAction({ venueId, view, onChanged }: ActionProps) {
  const t = useStaffT();
  const [form, setForm] = useState({ name: "", email: "", role: "desk", locale: "", password: "" });
  const [options, setOptions] = useState<StaffOptions>({ invitations: true, typedPassword: false });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const languages = view.profile.identity.staffLanguages;
  useEffect(() => {
    void fetch("/api/admin/admins", { cache: "no-store" })
      .then((r) => (r.ok ? readJson(r) : null))
      .then((d) => d && setOptions({ invitations: d.invitationsPossible !== false, typedPassword: !!d.typedPassword }))
      .catch(() => undefined);
  }, []);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body: Record<string, unknown> = { name: form.name, email: form.email, venueId, role: form.role };
      if (form.locale) body.locale = form.locale;
      if (options.typedPassword && form.password) body.password = form.password;
      const res = await fetch("/api/admin/admins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("gd.failed")));
      setNotice(data.invitation ? t("gs.act.staff.invited", { email: form.email }) : t("gs.act.staff.added", { email: form.email }));
      setForm({ ...form, name: "", email: "", password: "" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gd.failed"));
    } finally {
      setBusy(false);
    }
  }

  const s = view.profile.staff;
  return (
    <form onSubmit={invite} className="space-y-3">
      <p className="text-sm text-slate-600">{t("gs.act.staff.have", { managers: s.managers, desk: s.desk, pending: s.pendingInvitations })}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs font-medium text-slate-600">
          {t("c.name")}
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`mt-1 w-44 ${inputClass}`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-600">
          {t("c.email")}
          <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={`mt-1 w-56 ${inputClass}`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-600">
          {t("gs.act.staff.role")}
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className={`mt-1 ${inputClass}`}>
            <option value="desk">{t("vn.desk")}</option>
            <option value="manager">{t("vn.manager")}</option>
          </select>
        </label>
        {languages.length > 1 && (
          <label className="flex flex-col text-xs font-medium text-slate-600">
            {t("gs.act.staff.language")}
            <select value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })} className={`mt-1 ${inputClass}`}>
              <option value="">{t("gs.act.staff.languageDefault")}</option>
              {languages.map((l) => (
                <option key={l} value={l}>
                  {t(`gs.lang.${l}` as never)}
                </option>
              ))}
            </select>
          </label>
        )}
        {options.typedPassword && (
          <label className="flex flex-col text-xs font-medium text-slate-600">
            {t("gs.act.staff.password")}
            <input type="password" minLength={8} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className={`mt-1 w-44 ${inputClass}`} />
          </label>
        )}
        <button type="submit" disabled={busy} className={primary}>
          {options.invitations ? t("gs.act.staff.invite") : t("gs.act.staff.add")}
        </button>
      </div>
      <p className="text-xs text-slate-600">{t(form.role === "manager" ? "gs.act.staff.managerNote" : "gs.act.staff.deskNote")}</p>
      <Message error={error} notice={notice} />
    </form>
  );
}

// ---------------------------------------------------------------- the panels

function TryItAction({ view, onGo }: ActionProps) {
  return <SetupTryIt view={view} onGo={onGo} />;
}

function ReadinessAction({ view, onGo, onStep }: ActionProps) {
  const t = useStaffT();
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">{view.profile.identity.live ? t("gs.act.launch.live") : t("gs.act.launch.draft")}</p>
      <SetupReadiness view={view} onGo={onGo} onStep={onStep} />
    </div>
  );
}

/** Every action a step may run, by the id the plan names: a test holds this list to `SETUP_ACTIONS`. */
export const ACTIONS: Record<SetupAction, ComponentType<ActionProps>> = {
  hours: HoursAction,
  resources: ResourcesAction,
  prices: PricesAction,
  "peak-hours": PeakHoursAction,
  "price-dates": PriceDatesAction,
  "booking-rules": BookingRulesAction,
  cancellation: CancellationAction,
  staff: StaffAction,
  "try-it": TryItAction,
  readiness: ReadinessAction,
};

/** Actions that are an overview to read, not a form to open: shown with the step without a button to open them. */
export const ALWAYS_SHOWN: readonly SetupAction[] = ["try-it", "readiness"];
