"use client";

import { useCallback, useEffect, useState } from "react";
import { formatHour } from "@/lib/time";
import { MAX_EMERGENCY_INFO } from "@/lib/types";
import type { VenueClosure } from "@/lib/types";
import type { Admin } from "@/lib/admin-auth";
import { HOUR_CHOICES, todayLocal } from "./shared";
import { ClockField } from "@/components/ClockField";
import type { DayHours, WeekHours } from "@/lib/week-hours";
import { MessagesPanel } from "./MessagesPanel";
import { BlockedPhonesPanel } from "./BlockedPhonesPanel";
import { OnlinePaymentsPanel } from "./OnlinePaymentsPanel";
import { EInvoicePanel } from "./EInvoicePanel";
import { ReviewsPanel } from "./ReviewsPanel";
import { MarketingPanel } from "./MarketingPanel";
import { IntegrationsPanel } from "./IntegrationsPanel";
import { ApplicationsPanel } from "./ApplicationsPanel";
import { BillingPanel } from "./BillingPanel";
import { StorefrontsPanel } from "./StorefrontsPanel";
import { BranchRequestPanel, BusinessesPanel } from "./BusinessPanels";
import type { ManagedVenue } from "./shared";
import type { MapPoint } from "@/components/PinMap";
import PinPicker, { type PinPickerText } from "@/components/PinPicker";
import { FacilitiesEditor } from "./FacilitiesEditor";
import { PhotosEditor } from "./PhotosEditor";
import { NoticesEditor } from "./NoticesEditor";
import { AddonsEditor } from "./AddonsEditor";
import { WhatsAppEditor } from "./WhatsAppEditor";
import { AccessEditor } from "./AccessEditor";
import { HouseRulesEditor } from "./HouseRulesEditor";
import { PolicyOverridesEditor } from "./PolicyOverridesEditor";
import { WaiverEditor } from "./WaiverEditor";
import { TaxEditor } from "./TaxEditor";
import { TimeZoneEditor } from "./TimeZoneEditor";
import { CancelPolicyEditor } from "./CancelPolicyEditor";
import { CalendarFeedEditor } from "./CalendarFeedEditor";
import { DataRequestPanel } from "./DataRequestPanel";
import { ParticipantsPanel } from "./ParticipantsPanel";
import { BookingAlertsEditor } from "./BookingAlertsEditor";
import { RecentPhotosPanel } from "./RecentPhotosPanel";
import { minuteClock, region } from "@/lib/region";
import type { StaffText } from "@/lib/staff-text";
import type { EInvoiceRetention } from "@/lib/einvoice-retention";
import { useStaffClock, useStaffT } from "./StaffLanguage";
import DocumentPolicy from "./DocumentPolicy";

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
  const t = useStaffT();
  const isOwner = admin.venueId === null && admin.businessId === null;
  // A business manager runs every branch of their business, and its staff.
  const isManager = admin.businessId !== null;
  const managesStaff = isOwner || isManager;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [newVenue, setNewVenue] = useState({ name: "", area: "", address: "", phone: "" });
  // "" is another platform owner, "business" a manager of the whole business, an id that branch.
  const staffDefault = admin.venueId === null && admin.businessId !== null ? "business" : "";
  const [newStaff, setNewStaff] = useState({ name: "", email: "", password: "", venueId: staffDefault, role: "desk" });

  const loadAdmins = useCallback(async () => {
    if (!managesStaff) return;
    const res = await fetch("/api/admin/admins", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setAdmins(data.admins);
  }, [managesStaff]);

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
      if (!res.ok) throw new Error(t.err(data, t("vn.requestFailed")));
      setNotice(okMessage);
      await onChange();
      // The set-up checklist and the go-live banner tick off what was just saved (hours, pin, facilities).
      window.dispatchEvent(new Event("setup:refresh"));
      after?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vn.requestFailed"));
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

      {isOwner && <ApplicationsPanel onChange={() => void onChange()} />}

      <section>
        <h2 className="text-lg font-bold">
          {isOwner ? t("vn.venues") : isManager && venues.length > 1 ? t("vn.branches") : t("vn.details")}
        </h2>
        <div className="mt-3 space-y-3">
          {venues.map((venue) => (
            <VenueRow key={venue.id} venue={venue} onSave={send} isOwner={isOwner} />
          ))}
          {venues.length === 0 && (
            <p className="text-sm text-slate-500">{t("vn.noVenues")}</p>
          )}
        </div>
      </section>

      {isOwner && (
        <section>
          <h2 className="text-lg font-bold">{t("vn.siteNotice")}</h2>
          <NoticesEditor
            venueId="site"
            intro={t("vn.siteNoticeIntro")}
          />
        </section>
      )}

      {isOwner && <RecentPhotosPanel />}

      {isManager && <BranchRequestPanel businessName={admin.businessName ?? t("vn.yourBusiness")} onChange={() => void onChange()} />}

      <section>
        <h2 className="text-lg font-bold">{t("vn.closedDays")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("vn.closedIntro")}</p>
        <div className="mt-3 space-y-3">
          {venues.map((venue) => (
            <ClosuresRow key={venue.id} venue={venue} onError={setError} onNotice={setNotice} />
          ))}
        </div>
      </section>

      <BlockedPhonesPanel venues={venues} />

      <DataRequestPanel venues={venues} />

      <ParticipantsPanel venues={venues} role={admin.role} owner={isOwner} />

      <MessagesPanel venues={venues} isOwner={isOwner} />

      <ReviewsPanel venues={venues} isOwner={isOwner} />

      {admin.role !== "desk" && <MarketingPanel venues={venues} />}

      {admin.role !== "desk" && <IntegrationsPanel venues={venues} isOwner={isOwner} />}

      <OnlinePaymentsPanel venues={venues} desk={admin.role === "desk"} />

      {region().country === "MY" && admin.role !== "desk" && <EInvoicePanel venues={venues} />}

      <BillingPanel isOwner={isOwner} />

      {isOwner && <StorefrontsPanel venues={venues} />}

      {isOwner && <BackupsPanel />}

      {isOwner && <RetentionPanel />}

      {isOwner && <DocumentPolicy />}

      {isOwner && <BusinessesPanel venues={venues} onChange={() => void onChange()} />}

      {isOwner && (
          <section>
            <h3 className="font-semibold text-slate-700">{t("vn.addVenue")}</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send("/api/admin/venues", "POST", newVenue, t("vn.added", { name: newVenue.name }), () =>
                  setNewVenue({ name: "", area: "", address: "", phone: "" })
                );
              }}
              className="mt-2 flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-4"
            >
              <input
                required minLength={2} placeholder={t("vn.venueName")} value={newVenue.name}
                onChange={(e) => setNewVenue({ ...newVenue, name: e.target.value })}
                className={`w-48 ${inputClass}`}
              />
              <input
                required minLength={2} placeholder={t("vn.areaExample")} value={newVenue.area}
                onChange={(e) => setNewVenue({ ...newVenue, area: e.target.value })}
                className={`w-40 ${inputClass}`}
              />
              <input
                required minLength={2} placeholder={t("vn.address")} value={newVenue.address}
                onChange={(e) => setNewVenue({ ...newVenue, address: e.target.value })}
                className={`w-64 ${inputClass}`}
              />
              <input
                required minLength={2} placeholder={t("c.phone")} value={newVenue.phone}
                onChange={(e) => setNewVenue({ ...newVenue, phone: e.target.value })}
                className={`w-40 ${inputClass}`}
              />
              <button
                type="submit"
                className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
              >
                {t("vn.addVenueButton")}
              </button>
            </form>
          </section>
      )}

      {managesStaff && (
          <section>
            <h2 className="text-lg font-bold">{t("vn.staffAccounts")}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {isOwner ? t("vn.staffIntroOwner") : t("vn.staffIntroManager")}
            </p>
            {admins && (
              <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      {[t("c.name"), t("c.email"), t("vn.scope"), ""].map((h, i) => (
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
                          {a.businessId !== null ? (
                            <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
                              {t("vn.managerOf", { business: a.businessName ?? "" })}
                            </span>
                          ) : a.venueId === null ? (
                            <span className="rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-semibold text-violet-700">
                              {t("vn.platformOwner")}
                            </span>
                          ) : (
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                              <span className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-semibold text-teal-700">
                                {venues.find((v) => v.id === a.venueId)?.name ?? t("vn.venueN", { id: a.venueId })}
                              </span>
                              {/* What they may do there: run the day, or set the venue up too. */}
                              <select
                                aria-label={t("vn.roleOf", { name: a.name })}
                                value={a.role}
                                disabled={a.id === admin.id}
                                onChange={(e) =>
                                  send(`/api/admin/admins/${a.id}`, "PATCH", { role: e.target.value }, t("vn.roleChanged"), loadAdmins)
                                }
                                className="rounded-md border border-slate-300 px-1.5 py-0.5 text-xs"
                              >
                                <option value="manager">{t("vn.manager")}</option>
                                <option value="desk">{t("vn.desk")}</option>
                              </select>
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {a.id !== admin.id && (
                            <button
                              onClick={() => {
                                if (!window.confirm(t("vn.removeConfirm", { email: a.email }))) return;
                                send(`/api/admin/admins/${a.id}`, "DELETE", undefined, t("vn.removed"), loadAdmins);
                              }}
                              className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                            >
                              {t("c.remove")}
                            </button>
                          )}
                          {a.id !== admin.id && (
                            <button
                              onClick={() => {
                                // Only when they have lost both their authenticator and recovery codes (lib/two-factor-reset.ts).
                                const reason = window.prompt(t("vn.resetPrompt", { email: a.email }));
                                if (!reason) return;
                                const code = window.prompt(t("vn.ownCode"));
                                if (!code) return;
                                send(`/api/admin/admins/${a.id}/two-factor-reset`, "POST", { reason, code }, t("vn.resetDone"), loadAdmins);
                              }}
                              className="ml-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                            >
                              {t("vn.resetButton")}
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
                  newStaff.venueId === "business"
                    ? { ...newStaff, venueId: null, businessId: admin.businessId }
                    : { ...newStaff, venueId: newStaff.venueId ? Number(newStaff.venueId) : null },
                  t("vn.added", { name: newStaff.email }),
                  () => {
                    setNewStaff({ name: "", email: "", password: "", venueId: staffDefault, role: "desk" });
                    loadAdmins();
                  }
                );
              }}
              className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-4"
            >
              <input
                required minLength={2} placeholder={t("c.name")} value={newStaff.name}
                onChange={(e) => setNewStaff({ ...newStaff, name: e.target.value })}
                className={`w-40 ${inputClass}`}
              />
              <input
                required type="email" placeholder={t("c.email")} value={newStaff.email}
                onChange={(e) => setNewStaff({ ...newStaff, email: e.target.value })}
                className={`w-52 ${inputClass}`}
              />
              <input
                required type="password" minLength={8} placeholder={t("vn.password")}
                value={newStaff.password}
                onChange={(e) => setNewStaff({ ...newStaff, password: e.target.value })}
                className={`w-40 ${inputClass}`}
              />
              <select
                value={newStaff.venueId}
                onChange={(e) => setNewStaff({ ...newStaff, venueId: e.target.value })}
                className={inputClass}
              >
                {isOwner ? (
                  <option value="">{t("vn.ownerAll")}</option>
                ) : (
                  <option value="business">{t("vn.managerAll")}</option>
                )}
                {venues.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              {newStaff.venueId !== "" && newStaff.venueId !== "business" && (
                <select
                  aria-label={t("vn.role")}
                  value={newStaff.role}
                  onChange={(e) => setNewStaff({ ...newStaff, role: e.target.value })}
                  title={t("vn.roleHelp")}
                  className={inputClass}
                >
                  <option value="desk">{t("vn.desk")}</option>
                  <option value="manager">{t("vn.manager")}</option>
                </select>
              )}
              <button
                type="submit"
                className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
              >
                {t("vn.addStaff")}
              </button>
            </form>
          </section>
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
  const t = useStaffT();
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
      let res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = await res.json();
      // A day with bookings on it: only with a yes, and then they are told.
      if (res.status === 409 && typeof data.bookings === "number") {
        if (!window.confirm(t("vn.cancelAffectedConfirm", { error: t.err(data) })))
          return;
        res = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(body as object), cancelAffected: true }),
        });
        data = await res.json();
      }
      if (!res.ok) throw new Error(t.err(data, t("vn.requestFailed")));
      if (okMessage) onNotice(data.cancelled ? `${okMessage} ${t("vn.cancelledTold", { n: data.cancelled })}` : okMessage);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : t("vn.requestFailed"));
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold">{venue.name}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {closures.length === 0 && (
          <span className="text-xs text-slate-400">{t("vn.noClosures")}</span>
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
                  t("vn.reopened", { date: c.date })
                )
              }
              title={t("vn.reopen")}
              className="font-bold text-amber-700 hover:text-amber-900"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("c.date")}
          <input
            type="date"
            min={todayLocal()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 rounded-md border border-slate-200 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("vn.reasonOptional")}
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("vn.reasonExample")}
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
              t("vn.closed", { date })
            ).then(() => {
              setDate("");
              setReason("");
            })
          }
          className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-30"
        >
          {t("vn.closeDay")}
        </button>
      </div>
    </div>
  );
}

function VenueRow({
  venue,
  onSave,
  isOwner,
}: {
  venue: ManagedVenue;
  isOwner: boolean;
  onSave: (
    url: string,
    method: string,
    body: unknown,
    okMessage: string,
    after?: () => void
  ) => Promise<void>;
}) {
  const t = useStaffT();
  const dayNames = [t("vn.sunday"), t("vn.monday"), t("vn.tuesday"), t("vn.wednesday"), t("vn.thursday"), t("vn.friday"), t("vn.saturday")];
  const [fields, setFields] = useState({
    name: venue.name,
    area: venue.area,
    address: venue.address,
    phone: venue.phone,
    cancelCutoffHours: venue.cancelCutoffHours,
    openMin: venue.openMin,
    closeMin: venue.closeMin,
    weekHours: (venue.weekHours ?? null) as WeekHours | null,
    staffedFrom: venue.staffedFrom,
    staffedTo: venue.staffedTo,
    partlyUnstaffed: venue.partlyUnstaffed ?? "code",
    emergencyPhone: venue.emergencyPhone ?? "",
    emergencyInfo: venue.emergencyInfo ?? "",
  });
  const dirty =
    fields.name !== venue.name ||
    fields.area !== venue.area ||
    fields.address !== venue.address ||
    fields.phone !== venue.phone ||
    fields.cancelCutoffHours !== venue.cancelCutoffHours ||
    fields.openMin !== venue.openMin ||
    fields.closeMin !== venue.closeMin ||
    JSON.stringify(fields.weekHours) !== JSON.stringify(venue.weekHours ?? null) ||
    fields.staffedFrom !== venue.staffedFrom ||
    fields.staffedTo !== venue.staffedTo ||
    fields.partlyUnstaffed !== (venue.partlyUnstaffed ?? "code") ||
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
        {t("c.name")}
        <input
          value={fields.name}
          onChange={(e) => setFields({ ...fields, name: e.target.value })}
          className={`mt-1 w-52 ${inputClass}`}
        />
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        {t("vn.area")}
        <input
          value={fields.area}
          onChange={(e) => setFields({ ...fields, area: e.target.value })}
          className={`mt-1 w-36 ${inputClass}`}
        />
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        {t("vn.address")}
        <input
          value={fields.address}
          onChange={(e) => setFields({ ...fields, address: e.target.value })}
          className={`mt-1 w-72 ${inputClass}`}
        />
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        {t("c.phone")}
        <input
          value={fields.phone}
          onChange={(e) => setFields({ ...fields, phone: e.target.value })}
          className={`mt-1 w-36 ${inputClass}`}
        />
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        {t("vn.opens")}
        <ClockField
          label={t("vn.opens")}
          value={fields.openMin}
          onChange={(m) => setFields({ ...fields, openMin: m })}
          className={`mt-1 w-28 ${inputClass}`}
        />
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        {t("vn.closes")}
        <ClockField
          label={t("vn.closes")}
          value={fields.closeMin}
          after={fields.openMin}
          onChange={(m) => setFields({ ...fields, closeMin: m })}
          className={`mt-1 w-28 ${inputClass}`}
        />
      </label>
      <details className="w-full text-xs text-slate-600" open={fields.weekHours !== null}>
        <summary className="cursor-pointer font-medium text-slate-500">{t("vn.differentHours")}</summary>
        <p className="mt-1 text-slate-500">{t("vn.weekHoursIntro")}</p>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {[1, 2, 3, 4, 5, 6, 0].map((day) => {
            const d = fields.weekHours?.[day] ?? null;
            const setDay = (value: DayHours) => {
              const week = [...(fields.weekHours ?? Array(7).fill(null))] as WeekHours;
              week[day] = value;
              setFields({ ...fields, weekHours: week.every((x) => x === null) ? null : week });
            };
            return (
              <div key={day} className="flex flex-wrap items-center gap-1.5">
                <span className="w-24 font-medium">{dayNames[day]}</span>
                <select
                  aria-label={t("vn.dayHours", { day: dayNames[day] })}
                  value={d === null ? "usual" : d === "closed" ? "closed" : "own"}
                  onChange={(e) =>
                    setDay(e.target.value === "usual" ? null : e.target.value === "closed" ? "closed" : { open: fields.openMin, close: fields.closeMin })
                  }
                  className={inputClass}
                >
                  <option value="usual">{t("vn.usualHours")}</option>
                  <option value="own">{t("vn.ownHours")}</option>
                  <option value="closed">{t("vn.closedEveryWeek")}</option>
                </select>
                {d !== null && d !== "closed" && (
                  <>
                    <ClockField
                      label={t("vn.dayOpens", { day: dayNames[day] })}
                      value={d.open}
                      onChange={(m) => setDay({ open: m, close: Math.max(d.close, m + 1) })}
                      className={inputClass}
                    />
                    {t("vn.to")}
                    <ClockField
                      label={t("vn.dayCloses", { day: dayNames[day] })}
                      value={d.close}
                      after={d.open}
                      onChange={(m) => setDay({ open: d.open, close: m })}
                      className={inputClass}
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
      </details>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        {t("vn.cutoff")}
        <input
          type="number"
          min={0}
          max={72}
          value={fields.cancelCutoffHours}
          onChange={(e) =>
            setFields({ ...fields, cancelCutoffHours: Number(e.target.value) })
          }
          title={t("vn.cutoffHelp")}
          className={`mt-1 w-24 ${inputClass}`}
        />
      </label>
      <div className="w-full border-t border-slate-100 pt-3">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <p className="text-xs font-semibold text-slate-700">{t("vn.counter")}</p>
            <p className="text-xs text-slate-500">{t("vn.counterIntro")}</p>
          </div>
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("c.from")}
            <select
              value={fields.staffedFrom ?? ""}
              onChange={(e) =>
                setFields({
                  ...fields,
                  staffedFrom: e.target.value === "" ? null : Number(e.target.value),
                  staffedTo: e.target.value === "" ? null : (fields.staffedTo ?? Math.min(Math.ceil(fields.closeMin / 60), 28)),
                })
              }
              className={`mt-1 w-28 ${inputClass}`}
            >
              <option value="">{t("vn.always")}</option>
              {HOUR_CHOICES.map((h) => (
                <option key={h} value={h}>
                  {formatHour(h, t.locale)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("vn.toField")}
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
              <option value="">{t("vn.always")}</option>
              {HOUR_CHOICES.map((h) => (
                <option key={h} value={h}>
                  {formatHour(h, t.locale)}
                </option>
              ))}
            </select>
          </label>
          <span className="pb-1.5 text-xs font-medium text-slate-500">
            {alwaysStaffed
              ? t("vn.alwaysStaffed")
              : neverStaffed
                ? t("vn.neverStaffed")
                : t("vn.unstaffedOutside", { from: formatHour(fields.staffedFrom!, t.locale), to: formatHour(fields.staffedTo!, t.locale) })}
          </span>
        </div>

        {!alwaysStaffed && !neverStaffed && (
          <label className="mt-3 flex flex-col text-xs font-medium text-slate-500">
            {t("vn.partly")}
            <select
              value={fields.partlyUnstaffed}
              onChange={(e) => setFields({ ...fields, partlyUnstaffed: e.target.value as "code" | "counter" })}
              className={`mt-1 w-full max-w-md ${inputClass}`}
            >
              <option value="code">{t("vn.partlyCode")}</option>
              <option value="counter">{t("vn.partlyCounter")}</option>
            </select>
          </label>
        )}

        {!alwaysStaffed && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-xs font-medium text-slate-500">
              {t("vn.emergencyPhone")}
              <input
                value={fields.emergencyPhone}
                onChange={(e) => setFields({ ...fields, emergencyPhone: e.target.value })}
                placeholder={`+${region().phone.countryCode} ${region().phone.example.replace(/^0/, "")}`}
                title={t("vn.emergencyPhoneHelp")}
                className={`mt-1 w-40 ${inputClass}`}
              />
            </label>
            <label className="flex flex-1 flex-col text-xs font-medium text-slate-500">
              {t("vn.emergencyInfo")}
              <input
                value={fields.emergencyInfo}
                maxLength={MAX_EMERGENCY_INFO}
                onChange={(e) => setFields({ ...fields, emergencyInfo: e.target.value })}
                placeholder={t("vn.emergencyInfoExample")}
                className={`mt-1 w-full min-w-[16rem] ${inputClass}`}
              />
            </label>
          </div>
        )}
      </div>

      <span className="text-xs text-slate-400">{t("vn.courts", { n: venue.courts.length })}</span>
      <button
        disabled={!dirty}
        onClick={() => onSave(`/api/admin/venues/${venue.id}`, "PATCH", fields, t("vn.saved", { name: fields.name }))}
        className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-30"
      >
        {t("c.save")}
      </button>
      <VenueStanding venue={venue} isOwner={isOwner} onSave={onSave} />
      <FacilitiesEditor key={venue.amenities.join(",")} venue={venue} onSave={onSave} />
      <PhotosEditor venue={venue} />
      <AddonsEditor venue={venue} />
      <WhatsAppEditor venueId={venue.id} isOwner={isOwner} />
      <AccessEditor venueId={venue.id} />
      <HouseRulesEditor venueId={venue.id} />
      <PolicyOverridesEditor venueId={venue.id} />
      <WaiverEditor venueId={venue.id} />
      <CancelPolicyEditor venueId={venue.id} />
      <BookingAlertsEditor venueId={venue.id} />
      <CalendarFeedEditor venueId={venue.id} />
      <TaxEditor venueId={venue.id} />
      <TimeZoneEditor venueId={venue.id} />
      <NoticesEditor
        venueId={venue.id}
        intro={t("vn.noticeIntro")}
      />
    </div>
  );
}

/**
 * Where the venue is on the map, whether customers can see it, and — for the
 * platform owner — suspending it.
 */
function VenueStanding({
  venue,
  isOwner,
  onSave,
}: {
  venue: ManagedVenue;
  isOwner: boolean;
  onSave: (url: string, method: string, body: unknown, okMessage: string) => Promise<void>;
}) {
  const t = useStaffT();
  const [moving, setMoving] = useState(false);
  const [pin, setPin] = useState<MapPoint | null>(venue.lat !== null && venue.lng !== null ? { lat: venue.lat, lng: venue.lng } : null);
  const state =
    venue.publishedAt === null
      ? { text: t("vn.draft"), tone: "bg-slate-100 text-slate-700" }
      : venue.suspendedAt === null
        ? { text: t("vn.live"), tone: "bg-emerald-50 text-emerald-700" }
        : venue.suspendedBy === "owner"
          ? { text: t("vn.suspended", { reason: venue.suspendedReason ?? t("vn.byOwner") }), tone: "bg-red-50 text-red-700" }
          : { text: t("vn.overdue"), tone: "bg-red-50 text-red-700" };
  const pinText: PinPickerText = {
    label: t("vn.pinLabel"),
    hint: t("vn.pinHint"),
    find: t("vn.pinFind"),
    useLocation: t("vn.pinUseLocation"),
    looking: t("vn.pinLooking"),
    found: t("vn.pinFound"),
    notFound: t("vn.pinNotFound"),
    pinned: t("vn.pinPinned"),
    locationFailed: t("vn.pinLocationFailed"),
  };

  async function suspend() {
    const reason = window.prompt(t("vn.suspendPrompt", { name: venue.name }), "");
    if (!reason) return;
    await onSave("/api/admin/suspensions", "POST", { venueId: venue.id, action: "suspend", reason }, t("vn.isSuspended", { name: venue.name }));
  }

  return (
    <div className="w-full space-y-2 border-t border-slate-100 pt-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${state.tone}`}>{state.text}</span>
        <span className="text-xs text-slate-500">
          {pin ? t("vn.pinnedAt", { lat: pin.lat.toFixed(5), lng: pin.lng.toFixed(5) }) : t("vn.notOnMap")}
        </span>
        <button onClick={() => setMoving(!moving)} className="text-xs font-medium text-teal-700 underline">
          {moving ? t("vn.closeMap") : pin ? t("vn.movePin") : t("vn.pinIt")}
        </button>
        {isOwner && venue.publishedAt !== null && (
          venue.suspendedBy === "owner" ? (
            <button
              onClick={() => onSave("/api/admin/suspensions", "POST", { venueId: venue.id, action: "lift" }, t("vn.isBack", { name: venue.name }))}
              className="text-xs font-medium text-teal-700 underline"
            >
              {t("vn.lift")}
            </button>
          ) : (
            <button onClick={suspend} className="text-xs font-medium text-red-700 underline">
              {t("vn.suspend")}
            </button>
          )
        )}
      </div>
      {moving && (
        <div className="max-w-xl">
          <PinPicker query={`${venue.address}, ${venue.area}`} pin={pin} onPin={setPin} text={pinText} />
          <button
            disabled={!pin}
            onClick={() => pin && onSave(`/api/admin/venues/${venue.id}`, "PATCH", pin, t("vn.pinMoved", { name: venue.name }))}
            className="mt-2 rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-30"
          >
            {t("vn.savePin")}
          </button>
        </div>
      )}
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
/** A command, typed as it is in every language. */
const BACKUP_COMMAND = "npm run backup";

/** A backup's "YYYY-MM-DD HH:MM" (the install's clock, from its name) with the time as the staff language writes it. */
function takenText(takenAt: string, locale: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(takenAt);
  return m ? `${m[1]} ${minuteClock(Number(m[2]) * 60 + Number(m[3]), locale)}` : takenAt;
}

function BackupsPanel() {
  const t = useStaffT();
  const clock = useStaffClock();
  const HEALTH: Record<"ok" | "local_only" | "stale" | "paused" | "failing" | "none", string> = {
    ok: t("vn.healthOk"),
    local_only: t("vn.healthLocalOnly"),
    stale: t("vn.healthStale"),
    paused: t("vn.healthPaused"),
    failing: t("vn.healthFailing"),
    none: t("vn.healthNone"),
  };
  // What the storage address itself says about where the copies are.
  const endpointText = (e: { provider: string; region: string | null; country: string | null }) => {
    const provider = `${e.provider}${e.region && e.region !== "auto" ? ` ${e.region}` : ""}`;
    return e.country ? t("vn.addressNames", { provider, country: e.country }) : t("vn.addressNamesNoCountry", { provider });
  };
  const [state, setState] = useState<{
    backups: { name: string; bytes: number; takenAt: string; complete: boolean }[];
    directory: string;
    database: string;
    hoursSinceLast: number | null;
    offsite: {
      configured: boolean;
      destination: string | null;
      location?: string | null;
      endpointSays?: { provider: string; region: string | null; country: string | null } | null;
      paused?: string | null;
      pausedPhrase?: StaffText | null;
      lastCopied: { name: string; at: string; manifest?: boolean; encrypted?: boolean; signed?: boolean } | null;
      lastError: { at: string; error: string } | null;
    };
    health?: {
      state: "ok" | "local_only" | "stale" | "paused" | "failing" | "none";
      rpoHours: number;
      recoverableHours: number | null;
      offsite: "off" | "active" | "paused" | "failing";
      problems: string[];
      problemPhrases?: StaffText[];
    };
    schedule: { hour: number } | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/backup", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("vn.backupsReadFailed")));
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vn.backupsReadFailed"));
    }
  }, [t]);

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
      if (!res.ok) throw new Error(t.err(data, t("vn.backupFailed")));
      setNotice(
        t("vn.backupTaken", { name: data.file.name, kb: Math.round(data.file.bytes / 1024), bookings: data.bookings }) +
          (data.pruned.length > 0 ? ` ${t("vn.retired", { n: data.pruned.length })}` : "") +
          (data.offsite ? ` ${data.offsite.ok ? t("vn.copiedOffsite") : t("vn.offsiteCopyFailed")}` : "")
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vn.backupFailed"));
    } finally {
      setBusy(false);
    }
  }

  const stale = state !== null && (state.hoursSinceLast === null || state.hoursSinceLast > 48);

  return (
    <section>
      <h2 className="text-lg font-bold">{t("vn.backups")}</h2>
      <p className="mt-1 text-sm text-slate-500">{t("vn.backupsIntro")}</p>

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
              <span className="text-slate-500">{t("c.loading")}</span>
            ) : state.hoursSinceLast === null ? (
              <span className="font-semibold text-red-700">{t("vn.neverBackedUp")}</span>
            ) : (
              <span className={stale ? "font-semibold text-red-700" : "text-slate-700"}>
                {t("vn.newestBackup", { n: Math.round(state.hoursSinceLast) })}
                {stale && ` ${t("vn.checkSchedule")}`}
              </span>
            )}
          </div>
          <button
            onClick={takeOne}
            disabled={busy}
            className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? t("vn.taking") : t("vn.backUpNow")}
          </button>
        </div>

        {state?.health && (
          <div
            data-testid="backup-health"
            className={`mt-3 rounded-lg px-3 py-2 text-sm ${
              state.health.state === "ok" ? "bg-emerald-50 text-emerald-800" : state.health.state === "local_only" ? "bg-amber-50 text-amber-900" : "bg-red-50 text-red-700"
            }`}
          >
            <strong>{HEALTH[state.health.state]}</strong>
            {state.health.recoverableHours !== null &&
              ` · ${t("vn.recoverable", { hours: Math.floor(state.health.recoverableHours), target: state.health.rpoHours })}`}
            {state.health.problems.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {state.health.problems.map((p, i) => (
                  <li key={p}>{t.say(state.health!.problemPhrases?.[i], p)}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {state !== null && (
          <>
            <p className="mt-2 text-xs text-slate-500">
              <span className="font-mono">{state.database}</span> →{" "}
              <span className="font-mono">{state.directory}</span>
              {" · "}
              {state.schedule
                ? t("vn.scheduleAt", { time: formatHour(state.schedule.hour, t.locale) })
                : t("vn.scheduleOff", { command: BACKUP_COMMAND })}
            </p>
            <div
              className={`mt-3 rounded-lg px-3 py-2 text-sm ${
                !state.offsite.configured
                  ? "bg-amber-50 text-amber-900"
                  : state.offsite.paused ||
                      (state.offsite.lastError &&
                      (!state.offsite.lastCopied || state.offsite.lastError.at > state.offsite.lastCopied.at))
                    ? "bg-red-50 text-red-700"
                    : "bg-slate-50 text-slate-700"
              }`}
            >
              {!state.offsite.configured ? (
                <>
                  <strong>{t("vn.noOffsite")}</strong> {t("vn.sameDisk")} {t("vn.setOffsiteBefore")}{" "}
                  <span className="font-mono">OFFSITE_S3_*</span> {t("vn.setOffsiteAfter")}
                </>
              ) : (
                <>
                  {t("vn.offsiteTo")} <span className="font-mono text-xs">{state.offsite.destination}</span>
                  {state.offsite.location ? ` ${t("vn.dataKeptIn", { location: state.offsite.location })}` : ""}
                  {state.offsite.endpointSays && ` · ${endpointText(state.offsite.endpointSays)}`}
                  {state.offsite.lastCopied ? (
                    <>
                      {" "}
                      {t("vn.lastCopy")} <span className="font-mono text-xs">{state.offsite.lastCopied.name}</span>{" "}
                      {t("vn.lastCopyAt", { date: clock.day(state.offsite.lastCopied.at), time: clock.time(state.offsite.lastCopied.at) })}
                      {state.offsite.lastCopied.manifest ? t("vn.withManifest") : t("vn.noManifest")}
                      {state.offsite.lastCopied.encrypted ? t("vn.encrypted") : t("vn.notEncrypted")}
                      {state.offsite.lastCopied.signed ? t("vn.signed") : ""}
                    </>
                  ) : (
                    ` ${t("vn.nothingCopied")}`
                  )}
                  {state.offsite.paused && <div className="mt-1 font-semibold">{t("vn.offsitePaused", { reason: t.say(state.offsite.pausedPhrase, state.offsite.paused) })}</div>}
                  {!state.offsite.paused &&
                    state.offsite.lastError &&
                    (!state.offsite.lastCopied || state.offsite.lastError.at > state.offsite.lastCopied.at) && (
                      <div className="mt-1 font-semibold">{t("vn.lastCopyFailed", { error: state.offsite.lastError.error })}</div>
                    )}
                </>
              )}
            </div>
            {state.backups.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                {t("vn.nothingYet")} {t("vn.scheduleBefore")} <span className="font-mono">{BACKUP_COMMAND}</span>{" "}
                {t("vn.scheduleAfter")}
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      {[t("vn.colTaken"), t("vn.colFile"), t("vn.colSize"), t("vn.colSet")].map((h) => (
                        <th key={h} className="px-3 py-2 font-semibold">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {state.backups.map((b) => (
                      <tr key={b.name} className="border-b border-slate-100 last:border-0">
                        <td className="whitespace-nowrap px-3 py-2">{takenText(b.takenAt, t.locale)}</td>
                        <td className="px-3 py-2 font-mono text-xs">{b.name}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {Math.round(b.bytes / 1024)} KB
                        </td>
                        <td className={`whitespace-nowrap px-3 py-2 text-xs ${b.complete ? "text-emerald-700" : "text-amber-700"}`}>
                          {b.complete ? t("vn.whole") : t("vn.partMissing")}
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
  const t = useStaffT();
  const clock = useStaffClock();
  const [state, setState] = useState<{
    due: { what: string; whatPhrase?: StaffText; days: number; years?: number; action: string; affected: number }[];
    lastRun: string | null;
    einvoice?: EInvoiceRetention;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/retention", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("vn.retentionReadFailed")));
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vn.retentionReadFailed"));
    }
  }, [t]);

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
      if (!res.ok) throw new Error(t.err(data, t("vn.housekeepingFailed")));
      setNotice(data.total === 0 ? t("vn.nothingOld") : t("vn.recordsRemoved", { n: data.total }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vn.housekeepingFailed"));
    } finally {
      setBusy(false);
    }
  }

  const due = state?.due.reduce((n, l) => n + l.affected, 0) ?? 0;

  return (
    <section>
      <h2 className="text-lg font-bold">{t("vn.retention")}</h2>
      <p className="mt-1 text-sm text-slate-500">{t("vn.retentionIntro")}</p>

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
            {state === null ? t("c.loading") : due === 0 ? t("vn.nothingDue") : t("vn.recordsDue", { n: due })}
            {state?.lastRun && (
              <span className="text-slate-500">
                {" "}
                {t("vn.lastRun", { time: clock.time(state.lastRun) })}
              </span>
            )}
          </div>
          <button
            onClick={runNow}
            disabled={busy}
            className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? t("vn.running") : t("vn.runNow")}
          </button>
        </div>

        {state !== null && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[440px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  {[t("vn.colWhat"), t("vn.colKeptFor"), t("vn.colThen"), t("vn.colDue")].map((h) => (
                    <th key={h} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.due.map((line) => (
                  <tr key={line.what} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">{t.say(line.whatPhrase, line.what)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                      {line.years ? t("ei8.ret.yearsKept", { n: line.years }) : line.days === 0 ? t("vn.untilExpire") : t("vn.daysKept", { n: line.days })}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{t.known(`srv.ret.action.${line.action}`) ?? line.action}</td>
                    <td className="px-3 py-2 font-medium tabular-nums">
                      {line.affected === 0 ? "—" : line.affected}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-xs text-slate-500">{t("vn.neverDeleted")}</p>
      </div>
      {state?.einvoice && <EInvoiceRetentionCard retention={state.einvoice} onSaved={load} />}
    </section>
  );
}

/**
 * How long e-invoice records are kept (lib/einvoice-retention.ts): the
 * install's statutory period, provisional until the platform owner records
 * a review; less than the floor only with a review given with it.
 */
function EInvoiceRetentionCard({ retention, onSaved }: { retention: EInvoiceRetention; onSaved: () => void }) {
  const t = useStaffT();
  const [years, setYears] = useState(String(retention.years));
  const [review, setReview] = useState({ reviewerName: "", reviewerRole: "", firm: "", reviewedOn: "", adviceReference: "", basis: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const below = Number(years) < retention.floor;

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/retention", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("ei8.ret.failed")));
      setMessage({ ok: true, text: t("ei8.ret.saved") });
      onSaved();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : t("ei8.ret.failed") });
    } finally {
      setBusy(false);
    }
  }

  const field = (key: keyof typeof review, label: string, type = "text") => (
    <label key={key} className="block text-xs text-slate-600">
      {label}
      <input
        type={type}
        value={review[key]}
        onChange={(e) => setReview({ ...review, [key]: e.target.value })}
        className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
      />
    </label>
  );

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="font-semibold">{t("ei8.ret.title")}</h3>
      <p className="mt-1 text-sm text-slate-700">{t("ei8.ret.years", { n: retention.years })}</p>
      <p className="mt-1 text-xs text-slate-500">{t("ei8.ret.intro")}</p>
      <p className={`mt-2 text-xs ${retention.provisional ? "text-amber-700" : "text-slate-600"}`}>
        {retention.review
          ? t("ei8.ret.reviewed", {
              jurisdiction: retention.review.jurisdiction,
              name: retention.review.reviewerName,
              role: retention.review.reviewerRole,
              firm: retention.review.firm,
              date: retention.review.reviewedOn,
            })
          : t("ei8.ret.provisional")}
      </p>
      {message && <p className={`mt-2 text-sm ${message.ok ? "text-emerald-700" : "text-red-700"}`}>{message.text}</p>}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          {t("ei8.ret.yearsLabel")}
          <input
            type="number"
            min={retention.bounds[0]}
            max={retention.bounds[1]}
            value={years}
            onChange={(e) => setYears(e.target.value)}
            className="mt-1 block w-24 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <button
          type="button"
          disabled={busy || Number(years) === retention.years}
          onClick={() => void send({ action: "einvoice-years", years: Number(years), ...(below ? { review } : {}) })}
          className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {t("ei8.ret.save")}
        </button>
      </div>
      {below && <p className="mt-2 text-xs text-amber-700">{t("ei8.ret.belowFloor", { floor: retention.floor })}</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {field("reviewerName", t("ei8.ret.reviewerName"))}
        {field("reviewerRole", t("ei8.ret.reviewerRole"))}
        {field("firm", t("ei8.ret.firm"))}
        {field("reviewedOn", t("ei8.ret.reviewedOn"), "date")}
        {field("adviceReference", t("ei8.ret.adviceReference"))}
        {field("basis", t("ei8.ret.basis"))}
      </div>
      {!below && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void send({ action: "einvoice-review", jurisdiction: "MY", ...review })}
          className="mt-2 text-xs font-medium text-teal-700 hover:underline disabled:opacity-50"
        >
          {t("ei8.ret.recordReview")}
        </button>
      )}
    </div>
  );
}
