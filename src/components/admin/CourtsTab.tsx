"use client";

import { mostPerBookingAllowed, placesPerBooking, sportsOf } from "@/lib/court-activities";
import { activity, activityIcon } from "@/lib/activity-registry";
import { PeakHoursEditor } from "./PeakHoursEditor";
import { AddResourcesForm, CourtActivitiesEditor, SignOffsPanel, withMarks } from "./ResourcesEditor";
import { BookingPolicyEditor } from "./BookingPolicyEditor";
import { ApprovalSettings, ApprovalsReview, SupervisedAttendance } from "./ApprovalsPanel";
import { ApprovalHolds } from "./ApprovalRetention";
import { OutagesPanel } from "./OutagesPanel";
import { useCallback, useEffect, useState } from "react";
import { ConcessionsEditor } from "./ConcessionsEditor";
import { ResourceHeadings } from "./ResourceHeadings";
import { SportRulesEditor } from "./SportRulesEditor";
import { ACCESS_CODE_STALE_DAYS, MAX_ACCESS_CODE, MAX_CAPACITY, MAX_DEPOSIT } from "@/lib/types";
import type { Court, Induction, Venue } from "@/lib/types";
import type { AccessReveal } from "@/lib/store";
import { SURFACES, type CourtFeatures } from "@/lib/facilities";
import { hasPhrase, sportLabel, type T } from "@/lib/i18n";
import { region } from "@/lib/region";
import { useStaffClock, useStaffT } from "./StaffLanguage";
import { ParticipantPicker, type PickedParticipant } from "./ParticipantPicker";

/** A surface's name as customers read it, in the same language. */
const surfaceLabel = (t: T, x: string) => {
  const key = `surface.${x}`;
  return hasPhrase(key) ? t(key) : x;
};

/**
 * The choices for the most one booking may take: up to every place a resource
 * with places has, or up to MAX_PLAYERS on a court priced per player; with
 * the current setting always among them.
 */
function mostChoices(court: Court): number[] {
  const most = mostPerBookingAllowed(court.capacity);
  const steps = [1, 2, 4, 6, 10, 12, 16, 20, 30, 40, 50, 75, 100, 150, 200, 300, 400, 500].filter((n) => n <= most && (court.capacity > 1 || n >= 2));
  const all = new Set([...steps, ...(court.capacity > 1 ? [court.capacity] : []), ...(court.maxPlayers ? [court.maxPlayers] : [])]);
  return [...all].sort((a, b) => a - b);
}

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
  const t = useStaffT();
  const clock = useStaffClock();
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
      if (!res.ok) throw new Error(t.err(data));
      setNotice(t("ct.saved", { name: data.court.name }));
      refreshVenues();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
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
      if (!res.ok) throw new Error(t.err(data));
      setNotice(t("ct.savedFeatures", { name: data.court.name }));
      refreshVenues();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  async function saveLengths(
    court: Court,
    change: {
      perPlayer?: boolean;
      maxPlayers?: number | null;
      flatRate?: boolean;
      quantityPrices?: { from: number; percent: number }[] | null;
      classesOnly?: boolean;
    }
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
      if (!res.ok) throw new Error(t.err(data));
      setNotice(t("ct.savedBooking", { name: data.court.name }));
      refreshVenues();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  /** Open the door panel for a court, fetching its current code. */
  async function openDoor(court: Court) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/courts/${court.id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setDoor({
        court,
        code: data.access.code ?? "",
        changedAt: data.access.changedAt,
        stale: data.access.stale,
        unmanned: data.court.unmanned,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
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
      if (!res.ok) throw new Error(t.err(data));
      setDoor({
        court: data.court,
        code: data.access.code ?? "",
        changedAt: data.access.changedAt,
        stale: data.access.stale,
        unmanned: data.court.unmanned,
      });
      setNotice(
        data.court.unmanned ? t("ct.unmannedNotice", { name: data.court.name }) : t("ct.staffedNotice", { name: data.court.name })
      );
      refreshVenues();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  /** Who has been let in, on demand rather than on every page load. */
  async function loadReveals() {
    setError(null);
    try {
      const res = await fetch(`/api/admin/access?venueId=${venueId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setReveals(data.reveals);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
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
                  t("ct.col.court"), t("ct.col.sport"), t("ct.col.offPeak"), t("ct.col.peak"),
                  t("ct.col.memberOffPeak"), t("ct.col.memberPeak"), t("ct.col.capacity"), t("ct.col.deposit"), t("ct.col.door"), "",
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

      {venue && <BookingPolicyEditor key={`policies-${venue.id}`} venueId={venue.id} courts={venue.courts} />}

      {venue && <PeakHoursEditor key={venue.id} venueId={venue.id} />}

      {venue && (
        <SportRulesEditor
          key={`sport-rules-${venue.id}`}
          venueId={venue.id}
          sports={sportsOf(venue.courts)}
        />
      )}

      {venue && <ResourceHeadings key={`headings-${venue.id}`} courts={venue.courts} onSaved={refreshVenues} />}

      {venue && <ConcessionsEditor key={`concessions-${venue.id}`} venueId={venue.id} />}

      {venue && venue.courts.length > 0 && (
        <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="font-semibold">{t("ct.featuresTitle")}</h3>
          <p className="mt-1 text-sm text-slate-500">{t("ct.featuresIntro")}</p>
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
          <h3 className="font-semibold">{t("ct.pricingTitle")}</h3>
          <p className="mt-1 text-sm text-slate-500">{t("ct.pricingIntro")}</p>
          <table className="mt-2 w-full min-w-[480px] text-sm">
            <tbody>
              {venue.courts.map((court) => (
                <tr key={court.id} className="border-t border-slate-100">
                  <td className="py-1.5 pr-3 font-medium">{court.name}</td>
                  <td className="py-1.5 pl-3">
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
                      {court.capacity > 1 && (
                        <label className="flex items-center gap-1" title={t("ct.classesOnlyTitle")}>
                          <input
                            type="checkbox"
                            checked={!!court.classesOnly}
                            onChange={(e) => saveLengths(court, { classesOnly: e.target.checked })}
                          />
                          {t("ct.classesOnly")}
                        </label>
                      )}
                      {court.capacity === 1 ? (
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={!!court.perPlayer}
                            onChange={(e) => saveLengths(court, { perPlayer: e.target.checked })}
                          />
                          {t("ct.perPlayer")}
                        </label>
                      ) : (
                        <select
                          aria-label={t("ct.howPricedAria", { name: court.name })}
                          value={court.flatRate ? "booking" : "place"}
                          onChange={(e) => saveLengths(court, { flatRate: e.target.value === "booking" })}
                          className="rounded-md border border-slate-300 px-1.5 py-1 text-sm"
                        >
                          <option value="place">{t("ct.perPlace")}</option>
                          <option value="booking">{t("ct.onePrice")}</option>
                        </select>
                      )}
                      {(court.perPlayer || court.capacity > 1) && (
                        <select
                          aria-label={t("ct.mostAria", { name: court.name })}
                          value={court.maxPlayers ?? ""}
                          onChange={(e) => saveLengths(court, { maxPlayers: e.target.value === "" ? null : Number(e.target.value) })}
                          className="rounded-md border border-slate-300 px-1.5 py-1 text-sm"
                        >
                          <option value="">{t("ct.upTo", { n: placesPerBooking({ ...court, maxPlayers: null }) })}</option>
                          {mostChoices(court).map((n) => (
                            <option key={n} value={n}>
                              {t("ct.upTo", { n })}
                            </option>
                          ))}
                        </select>
                      )}
                      {(court.perPlayer || (court.capacity > 1 && !court.flatRate)) && (
                        <QuantityPriceField
                          courtName={court.name}
                          value={court.quantityPrices ?? null}
                          onSave={(quantityPrices) => saveLengths(court, { quantityPrices })}
                        />
                      )}
                    </span>
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
            <p className="text-sm font-semibold">{t("ct.doorTitle", { name: door.court.name })}</p>
            <button
              onClick={() => setDoor(null)}
              className="text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              {t("c.close")}
            </button>
          </div>
          <p className="mt-0.5 text-xs text-slate-600">{t("ct.doorIntro")}</p>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-600">{t("ct.lockCode")}</label>
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
              {t("ct.saveCode")}
            </button>
            <button
              onClick={() => saveDoor({ unmanned: !door.unmanned })}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                door.unmanned
                  ? "border border-slate-300 text-slate-600 hover:bg-slate-50"
                  : "bg-teal-600 text-white hover:bg-teal-700"
              }`}
            >
              {door.unmanned ? t("ct.staffIt") : t("ct.leaveUnmanned")}
            </button>
            {door.code !== "" && (
              <button
                onClick={() => saveDoor({ accessCode: null })}
                title={t("ct.clearTitle")}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-red-600"
              >
                {t("ct.clear")}
              </button>
            )}
          </div>

          <p className="mt-2 text-xs text-slate-600">
            {door.unmanned ? t("ct.unmannedState") : t("ct.staffedState")}
            {door.changedAt && ` ${t("ct.codeChanged", { when: clock.time(door.changedAt, venueId) })}`}
          </p>
          {door.stale && (
            <p className="mt-1 text-xs font-medium text-red-700">
              {t("ct.stale", { days: ACCESS_CODE_STALE_DAYS })}
            </p>
          )}
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">{t("ct.logTitle")}</p>
            <p className="text-xs text-slate-500">{t("ct.logIntro")}</p>
          </div>
          <button
            onClick={() => (reveals === null ? loadReveals() : setReveals(null))}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-teal-500 hover:text-teal-700"
          >
            {reveals === null ? t("ct.showLog") : t("c.hide")}
          </button>
        </div>
        {reveals !== null &&
          (reveals.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">{t("ct.logEmpty")}</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[460px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    {[t("ct.log.when"), t("ct.log.code"), t("ct.col.court"), t("ct.log.customer"), t("c.phone")].map((h) => (
                      <th key={h} className="px-3 py-2 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reveals.map((r, i) => (
                    <tr key={i} className="border-b border-slate-100 last:border-0">
                      <td className="whitespace-nowrap px-3 py-2">{clock.time(r.revealedAt, venueId)}</td>
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

      <AddResourcesForm
        key={`add-${venueId}`}
        venueId={venueId}
        onAdded={(message) => {
          setError(null);
          setNotice(message);
          refreshVenues();
        }}
      />

      {venue && venue.courts.length > 0 && (
        <CourtActivitiesEditor
          key={`activities-${venue.id}`}
          venueId={venue.id}
          courts={venue.courts}
          onSaved={(message) => {
            setError(null);
            setNotice(message);
            refreshVenues();
          }}
        />
      )}

      {venue && <SignOffsPanel key={`signoffs-${venue.id}`} venueId={venue.id} courts={venue.courts} />}
      {venue && <ApprovalsReview key={`approvals-${venue.id}`} venueId={venue.id} />}
      {venue && <ApprovalSettings key={`approval-settings-${venue.id}`} venueId={venue.id} courts={venue.courts} />}
      {venue && <SupervisedAttendance key={`supervised-${venue.id}`} venueId={venue.id} />}
      {venue && <ApprovalHolds key={`approval-holds-${venue.id}`} venueId={venue.id} />}
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
  const t = useStaffT();
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
        {activityIcon(court.sport)} {sportLabel(t.customer, court.sport)}
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
          title={t("ct.memberOffPeakTitle")}
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
          title={t("ct.memberPeakTitle")}
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
          title={t("ct.capacityTitle")}
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
          title={t("ct.depositTitle")}
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <button
          onClick={onDoor}
          title={t("ct.doorButtonTitle")}
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold transition ${
            court.unmanned
              ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
              : "bg-slate-100 text-slate-500 hover:bg-slate-200"
          }`}
        >
          {court.unmanned ? t("ct.unmanned") : t("ct.staffed")}
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
          {t("c.save")}
        </button>
      </td>
    </tr>
  );
}


function CourtFeaturesRow({ court: saved, onFeatures: save }: { court: Court; onFeatures: (change: Partial<CourtFeatures>) => void }) {
  const t = useStaffT();
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
        {activityIcon(court.sport)} {court.name}
      </td>
      <td className="px-3 py-2">
        {/* For players comparing venues; saved as soon as it changes. */}
        <div className="flex min-w-[15rem] flex-wrap items-center gap-2 text-xs">
          <select
            aria-label={t("ct.settingAria", { name: court.name })}
            value={court.setting ?? ""}
            onChange={(e) => onFeatures({ setting: e.target.value === "" ? null : (e.target.value as "indoor" | "outdoor") })}
            className="rounded-md border border-slate-200 px-1.5 py-1"
          >
            <option value="">{t("ct.settingUnset")}</option>
            <option value="indoor">{t("res.indoor")}</option>
            <option value="outdoor">{t("res.outdoor")}</option>
          </select>
          <label className="flex items-center gap-1" title={t("ct.airconTitle")}>
            <input type="checkbox" checked={court.aircon} onChange={(e) => onFeatures({ aircon: e.target.checked })} />
            ❄️ {t("ct.aircon")}
          </label>
          <label className="flex items-center gap-1" title={t("ct.litTitle")}>
            <input type="checkbox" checked={court.floodlit} onChange={(e) => onFeatures({ floodlit: e.target.checked })} />
            💡 {t("ct.lit")}
          </label>
          {activity(court.sport).surfaced && (
            <select
              aria-label={t("ct.surfaceAria", { name: court.name })}
              value={court.surface ?? ""}
              onChange={(e) => onFeatures({ surface: e.target.value === "" ? null : (e.target.value as CourtFeatures["surface"]) })}
              className="rounded-md border border-slate-200 px-1.5 py-1"
            >
              <option value="">{t("ct.surfaceUnset")}</option>
              {SURFACES.map((x) => (
                <option key={x} value={x}>
                  {surfaceLabel(t.customer, x)}
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
  const t = useStaffT();
  const clock = useStaffClock();
  const [inductions, setInductions] = useState<Induction[] | null>(null);
  const [form, setForm] = useState({ phone: "", name: "", note: "" });
  // Who was shown round: the number's holder, or a participant on it (a child; lib/participants.ts).
  const [who, setWho] = useState<PickedParticipant | null>(null);
  const [checking, setChecking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/inductions?venueId=${venueId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setInductions(data.inductions);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
      setInductions(null);
    }
  }, [venueId, t]);

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
        body: JSON.stringify({ venueId, ...form, ...(who ? { participantId: who.id } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setNotice(t("ct.inducted", { name: data.induction.name }));
      setForm({ phone: "", name: "", note: "" });
      setWho(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  async function revoke(induction: Induction) {
    if (!window.confirm(t("ct.withdrawConfirm", { name: induction.name }))) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/inductions/${induction.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setNotice(t("ct.withdrawn", { name: induction.name }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <p className="text-sm font-semibold">{t("ct.inductTitle")}</p>
      <p className="text-xs text-slate-500">{t("ct.inductIntro")}</p>

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
          placeholder={t("c.name")}
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
          placeholder={t("ct.inductNotePh")}
          className="w-56 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700"
        >
          {t("ct.recordInduction")}
        </button>
        <ParticipantPicker venueId={venueId} phone={form.phone} guardianName={form.name} value={who} onChange={setWho} showInducted />
      </form>

      {inductions !== null &&
        (inductions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">{t("ct.inductEmpty")}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  {[t("c.name"), t("c.phone"), t("ct.ind.inducted"), t("ct.ind.by"), t("ct.ind.note"), ""].map((h, i) => (
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
                    <td className="px-3 py-2 font-medium">
                      {i.name}
                      {i.forParticipant && <span className="ml-1 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-normal text-sky-700">{t("ptc.ind.participant")}</span>}
                      {i.assignedFromName && <span className="block text-xs font-normal text-slate-500">{t("ptc.ind.wasFiled", { name: i.assignedFromName })}</span>}
                      {i.needsReview && !i.revokedAt && (
                        <span className="ml-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-normal text-amber-700">{t("ptc.ind.check")}</span>
                      )}
                      {i.reviewNote && <span className="block text-xs font-normal text-slate-500">{t("ptc.ind.reviewed", { name: i.reviewedBy ?? "—", note: i.reviewNote })}</span>}
                      {checking === i.id && (
                        <WhoseInduction
                          induction={i}
                          venueId={venueId}
                          onDone={() => {
                            setChecking(null);
                            load();
                          }}
                        />
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{i.phone}</td>
                    <td className="whitespace-nowrap px-3 py-2">{clock.time(i.createdAt, venueId)}</td>
                    <td className="px-3 py-2">{i.adminName ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-500">{i.note ?? "—"}</td>
                    <td className="px-3 py-2 text-right">
                      {!i.revokedAt && !i.forParticipant && checking !== i.id && (
                        <button
                          onClick={() => setChecking(i.id)}
                          className="mr-2 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          {t("ptc.ind.whose")}
                        </button>
                      )}
                      {i.revokedAt ? (
                        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold">
                          {t("ct.ind.withdrawn")}
                        </span>
                      ) : (
                        <button
                          onClick={() => revoke(i)}
                          className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                        >
                          {t("ct.ind.withdraw")}
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
 * Whose a number-keyed induction is (lib/participants.ts assignInduction): a
 * manager gives it to the participant it was really for, a child on that
 * number, or confirms it is the number holder's own; a reason either way,
 * recorded. Never decided by the number alone.
 */
function WhoseInduction({ induction, venueId, onDone }: { induction: Induction; venueId: number; onDone: () => void }) {
  const t = useStaffT();
  const [who, setWho] = useState<PickedParticipant | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      const res = await fetch(`/api/admin/inductions/${induction.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantId: who?.id ?? null, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  return (
    <div className="mt-2 space-y-1 rounded-lg border border-amber-100 bg-amber-50/40 p-2 text-sm font-normal">
      <p className="text-xs text-slate-600">{t("ptc.ind.whoseIntro")}</p>
      <ParticipantPicker venueId={venueId} phone={induction.phone} guardianName={induction.name} value={who} onChange={setWho} showInducted />
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t("ptc.ind.reason")}
        className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
      />
      {error && <p className="text-xs text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => void save()} className="rounded-lg bg-teal-600 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700">
          {who ? t("ptc.ind.give", { name: who.displayName }) : t("ptc.ind.keep")}
        </button>
        <button type="button" onClick={onDone} className="rounded-lg border border-slate-300 px-3 py-1 text-xs">
          {t("ptc.ind.cancel")}
        </button>
      </div>
    </div>
  );
}

/**
 * One floor sold more than one way (lib/court-links.ts): a futsal pitch that
 * is also four badminton courts. Booking the pitch takes the four; booking
 * any of the four takes the pitch.
 */
function CourtLinksEditor({ venueId, courts }: { venueId: number; courts: Court[] }) {
  const t = useStaffT();
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

  const name = (id: number) => courts.find((c) => c.id === id)?.name ?? t("ct.courtN", { id });
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
      if (!res.ok) throw new Error(t.err(data));
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (!links) return null;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">{t("ct.linksTitle")}</h3>
      <p className="mt-1 text-xs text-slate-500">{t("ct.linksIntro")}</p>
      {wholes.length > 0 && (
        <ul className="mt-3 space-y-1">
          {wholes.map((w) => (
            <li key={w} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{name(w)}</span>
              <span className="text-slate-500">{t("ct.takes", { courts: partsOf(w).map(name).join(", ") })}</span>
              <button
                onClick={() => setEditing({ wholeId: w, parts: partsOf(w) })}
                className="text-xs font-semibold text-teal-700 underline"
              >
                {t("c.change")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <label className="flex items-center gap-2">
            {withMarks(t("ct.alsoTakes"), {
              court: (
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
              ),
            })}
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
              {t("c.save")}
            </button>
            <button onClick={() => setEditing(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">
              {t("c.cancel")}
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
          {t("ct.linkCourts")}
        </button>
      )}
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
    </section>
  );
}

/** One lower price for a larger booking: from so many, each at a percent of the rate. */
function QuantityPriceField({
  courtName,
  value,
  onSave,
}: {
  courtName: string;
  value: { from: number; percent: number }[] | null;
  onSave: (bands: { from: number; percent: number }[] | null) => void;
}) {
  const t = useStaffT();
  const first = value?.[0];
  const [from, setFrom] = useState(first ? String(first.from) : "");
  const [percent, setPercent] = useState(first ? String(first.percent) : "");
  return (
    <span className="flex items-center gap-1">
      {withMarks(t("ct.qtyRule"), {
        from: (
          <input
            aria-label={t("ct.qtyFromAria", { name: courtName })}
            type="number"
            min={2}
            max={50}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-14 rounded-md border border-slate-300 px-1.5 py-1 text-sm"
          />
        ),
        percent: (
          <input
            aria-label={t("ct.qtyPercentAria", { name: courtName })}
            type="number"
            min={1}
            max={99}
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            className="w-14 rounded-md border border-slate-300 px-1.5 py-1 text-sm"
          />
        ),
      })}
      <button
        type="button"
        onClick={() => onSave(from === "" || percent === "" ? null : [{ from: Number(from), percent: Number(percent) }])}
        className="rounded-md bg-slate-100 px-2 py-1 font-medium text-slate-700 hover:bg-slate-200"
      >
        {t("c.save")}
      </button>
    </span>
  );
}
