"use client";

import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import type { Admin } from "@/lib/admin-auth";
import { BookingsTab } from "@/components/admin/BookingsTab";
import { ChangePassword } from "@/components/ChangePassword";
import { ClassesTab } from "@/components/admin/ClassesTab";
import { CourtsTab } from "@/components/admin/CourtsTab";
import { CreditTab } from "@/components/admin/CreditTab";
import { FirstRun } from "@/components/admin/FirstRun";
import { GoLiveBanner } from "@/components/admin/GoLiveBanner";
import { OccupancyTab } from "@/components/admin/OccupancyTab";
import { ReportsTab } from "@/components/admin/ReportsTab";
import { ScheduleTab } from "@/components/admin/ScheduleTab";
import { LeaguesTab } from "@/components/admin/LeaguesTab";
import { TournamentsTab } from "@/components/admin/TournamentsTab";
import { SetupChecklist } from "@/components/admin/SetupChecklist";
import { BookingLinkCard } from "@/components/admin/BookingLinkCard";
import { ApprovalsReview, RevocationFlags } from "@/components/admin/ApprovalsPanel";
import { SystemHealth } from "@/components/admin/SystemHealth";
import { ErrorsPanel } from "@/components/admin/ErrorsPanel";
import { IntegrityCheck } from "@/components/admin/IntegrityCheck";
import { PlayerReportsPanel } from "@/components/admin/PlayerReportsPanel";
import { VenuesTab } from "@/components/admin/VenuesTab";
import type { ManagedVenue } from "@/components/admin/shared";
import { TwoFactorPanel } from "@/components/admin/TwoFactorPanel";
import type { TwoFactorStatus } from "@/lib/two-factor";
import { useStaffT } from "@/components/admin/StaffLanguage";

type Tab =
  | "bookings"
  | "schedule"
  | "occupancy"
  | "reports"
  | "courts"
  | "classes"
  | "tournaments"
  | "leagues"
  | "credit"
  | "venues";

/** A phrase with elements (a button, a link) where its `{name}` placeholders are. */
function withElements(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((piece, i) => (i % 2 ? <Fragment key={i}>{parts[piece] ?? `{${piece}}`}</Fragment> : piece));
}

export default function AdminPage() {
  const t = useStaffT();
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [venues, setVenues] = useState<ManagedVenue[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Two-factor: the ticket the password earned, the code that completes it, and this account's state.
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [twoFactor, setTwoFactor] = useState<TwoFactorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("bookings");

  /** Re-read the session and the venues this admin may manage. */
  const refreshVenues = useCallback(async () => {
    const res = await fetch("/api/admin/auth/me", { cache: "no-store" });
    const data = await res.json();
    setAdmin(data.admin);
    setVenues(data.venues);
    setTwoFactor(data.twoFactor ?? null);
    return data.admin as Admin | null;
  }, []);

  useEffect(() => {
    refreshVenues()
      .catch(() => setAdmin(null))
      .finally(() => setLoaded(true));
  }, [refreshVenues]);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ticket ? { ticket, code } : { email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        // A ticket that ran out (or too many wrong codes) means the password again.
        if (ticket && /timed out|again/i.test(data.error ?? "")) setTicket(null);
        throw new Error(t.err(data, t("sh.signInFailed")));
      }
      if (data.twoFactor) {
        setTicket(data.ticket);
        setCode("");
        return;
      }
      await refreshVenues();
      setPassword("");
      setTicket(null);
      setCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sh.signInFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/admin/auth/logout", { method: "POST" });
    setAdmin(null);
    setVenues([]);
  }

  if (!loaded) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
        {t("c.loading")}
      </div>
    );
  }

  if (!admin) {
    return (
      <div className="mx-auto max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-bold">{t("sh.venueAdmin")}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {t("sh.signInIntro")}
          </p>
        </div>
        <form
          onSubmit={signIn}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          {ticket ? (
            <label className="block text-sm font-medium text-slate-700">
              {t("sh.codeLabel")}
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-center font-mono tracking-widest focus:border-teal-500 focus:outline-none"
              />
              <span className="mt-1 block text-xs font-normal text-slate-500">{t("sh.lostPhone")}</span>
            </label>
          ) : (
          <>
          <label className="block text-sm font-medium text-slate-700">
            {t("c.email")}
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@venue.com"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            {t("sh.password")}
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none"
            />
          </label>
          </>
          )}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? t("sh.checking") : t("sh.signIn")}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <a href="/forgot-password?kind=admin" className="block text-center text-sm text-teal-700 underline">
            {t("sh.forgot")}
          </a>
        </form>
      </div>
    );
  }

  // Required here and not yet set up: that comes first, and only that.
  if (twoFactor?.required && !twoFactor.enabled)
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <h1 className="text-2xl font-bold">{t("tfa.setUp")}</h1>
        <p className="text-sm text-slate-600">
          {t("sh.tfaRequired", { name: admin.name })}
        </p>
        <TwoFactorPanel status={twoFactor} onChange={() => void refreshVenues()} />
        <button onClick={signOut} className="text-sm text-slate-500 underline">
          {t("sh.signOut")}
        </button>
      </div>
    );

  const isOwner = admin.venueId === null && admin.businessId === null;
  const isManager = admin.businessId !== null;
  // Front desk runs the day; the money totals and the staff log are a manager's.
  const desk = admin.role === "desk";
  const tabs: [Tab, string][] = [
    ["bookings", t("sh.tab.bookings")],
    ["schedule", t("sh.tab.schedule")],
    ["occupancy", t("sh.tab.occupancy")],
    ...(desk ? [] : ([["reports", t("sh.tab.reports")]] as [Tab, string][])),
    ["courts", t("sh.tab.courts")],
    ["classes", t("sh.tab.classes")],
    ["tournaments", t("sh.tab.tournaments")],
    ["leagues", t("sh.tab.leagues")],
    ["credit", t("sh.tab.credit")],
    ["venues", isOwner ? t("sh.tab.venuesStaff") : isManager ? t("sh.tab.branchesStaff") : t("sh.tab.venueDetails")],
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("sh.dashboard")}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {admin.name} ·{" "}
            {isOwner ? (
              <span className="font-medium text-teal-700">{t("sh.platformOwner")}</span>
            ) : isManager && venues.length > 1 ? (
              <span className="font-medium text-teal-700">
                {admin.businessName} · {t.plural("sh.branches", venues.length)}
              </span>
            ) : (
              <span className="font-medium text-teal-700">
                {venues[0]?.name ?? t("sh.yourVenue")}
                {desk && <span className="ml-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{t("sh.frontDesk")}</span>}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-col items-end">
          <button
            onClick={signOut}
            className="inline-flex min-h-9 items-center rounded-md px-2 text-sm text-slate-500 underline hover:text-teal-700"
          >
            {t("sh.signOut")}
          </button>
          <ChangePassword endpoint="/api/admin/auth/password" />
        </div>
      </div>

      {twoFactor && (
        <details className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm">
          <summary className="cursor-pointer font-medium text-slate-700">
            {twoFactor.enabled ? t("sh.tfaOn") : t("sh.tfaOff")}
          </summary>
          <div className="mt-2">
            <TwoFactorPanel status={twoFactor} onChange={setTwoFactor} />
          </div>
        </details>
      )}

      {isOwner && <SystemHealth />}
      {isOwner && <ErrorsPanel />}
      {isOwner && <IntegrityCheck venues={venues} />}
      {isOwner && <PlayerReportsPanel />}
      {isOwner && <FirstRun onSeeded={refreshVenues} />}
      {/* One for each branch still being set up; each disappears once its branch is ready. */}
      {/* Each draft branch, until it is live; and any venue taken off for an unpaid invoice. */}
      {!isOwner &&
        venues
          .filter((venue) => venue.publishedAt === null || venue.suspendedAt !== null)
          .map((venue) => (
            <GoLiveBanner
              key={`live-${venue.id}`}
              venueId={venue.id}
              venueName={venues.length > 1 ? venue.name : null}
              refreshKey={`${tab}:${venue.courts.length}`}
              onChange={refreshVenues}
            />
          ))}
      {!isOwner &&
        venues.map((venue, i) => (
          <SetupChecklist
            key={venue.id}
            venueId={venue.id}
            venueName={venues.length > 1 ? venue.name : null}
            startOpen={i === 0}
            // A string, so it changes only when a step might have: a new tab, or a court added.
            refreshKey={`${tab}:${venue.courts.length}`}
            onGo={setTab}
          />
        ))}

      {/* Where customers book: to copy, share or print, for each venue that is live. */}
      {!isOwner && tab === "bookings" && (
        <div className="grid gap-3 lg:grid-cols-2">
          {venues
            .filter((venue) => venue.publishedAt !== null && venue.suspendedAt === null)
            .map((venue) => (
              <BookingLinkCard key={`link-${venue.id}`} venueId={venue.id} venueName={venues.length > 1 ? venue.name : null} />
            ))}
        </div>
      )}

      {/* Applications to be approved for an activity, waiting on the venue: shown only when there are some. */}
      {!isOwner &&
        tab === "bookings" &&
        venues.map((venue) => <ApprovalsReview key={`approvals-${venue.id}`} venueId={venue.id} venueName={venues.length > 1 ? venue.name : null} waitingOnly />)}
      {/* Bookings to decide after an approval was taken back: shown only when there are some. */}
      {!isOwner && tab === "bookings" && venues.map((venue) => <RevocationFlags key={`approval-flags-${venue.id}`} venueId={venue.id} />)}

      <div className="flex flex-wrap gap-2">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
              tab === id
                ? "bg-teal-600 text-white shadow"
                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {venues.length === 0 && tab !== "venues" ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          {withElements(t("sh.noVenues"), {
            tab: (
              <button onClick={() => setTab("venues")} className="font-medium text-teal-700 underline">
                {t("sh.tab.venuesStaff")}
              </button>
            ),
          })}
        </div>
      ) : (
        <>
          {tab === "bookings" && <BookingsTab />}
          {tab === "schedule" && <ScheduleTab venues={venues} />}
          {tab === "occupancy" && <OccupancyTab venues={venues} />}
          {tab === "reports" && <ReportsTab venues={venues} />}
          {tab === "courts" && <CourtsTab venues={venues} onVenuesChange={refreshVenues} />}
          {tab === "classes" && <ClassesTab venues={venues} />}
          {tab === "tournaments" && <TournamentsTab venues={venues} />}
          {tab === "leagues" && <LeaguesTab venues={venues} />}
          {tab === "credit" && <CreditTab venues={venues} />}
          {tab === "venues" && (
            <VenuesTab admin={admin} venues={venues} onChange={refreshVenues} />
          )}
        </>
      )}
    </div>
  );
}
