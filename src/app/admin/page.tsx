"use client";

import { useCallback, useEffect, useState } from "react";
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
import { SystemHealth } from "@/components/admin/SystemHealth";
import { ErrorsPanel } from "@/components/admin/ErrorsPanel";
import { VenuesTab } from "@/components/admin/VenuesTab";
import type { ManagedVenue } from "@/components/admin/shared";
import { TwoFactorPanel } from "@/components/admin/TwoFactorPanel";
import type { TwoFactorStatus } from "@/lib/two-factor";

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

export default function AdminPage() {
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
        throw new Error(data.error ?? "Sign-in failed");
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
      setError(err instanceof Error ? err.message : "Sign-in failed");
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
        Loading…
      </div>
    );
  }

  if (!admin) {
    return (
      <div className="mx-auto max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Venue admin</h1>
          <p className="mt-1 text-sm text-slate-600">
            Sign in with your operator account to manage your venue.
          </p>
        </div>
        <form
          onSubmit={signIn}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          {ticket ? (
            <label className="block text-sm font-medium text-slate-700">
              Code from your authenticator app
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
              <span className="mt-1 block text-xs font-normal text-slate-500">Lost your phone? A recovery code works here too.</span>
            </label>
          ) : (
          <>
          <label className="block text-sm font-medium text-slate-700">
            Email
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
            Password
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
            {busy ? "Checking…" : "Sign in"}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <a href="/forgot-password?kind=admin" className="block text-center text-sm text-teal-700 underline">
            Forgot your password?
          </a>
        </form>
      </div>
    );
  }

  // Required here and not yet set up: that comes first, and only that.
  if (twoFactor?.required && !twoFactor.enabled)
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <h1 className="text-2xl font-bold">Set up two-factor sign-in</h1>
        <p className="text-sm text-slate-600">
          {admin.name}, this site asks every staff account like yours to sign in with a code from a phone app as well as
          a password. It takes a minute.
        </p>
        <TwoFactorPanel status={twoFactor} onChange={() => void refreshVenues()} />
        <button onClick={signOut} className="text-sm text-slate-500 underline">
          Sign out
        </button>
      </div>
    );

  const isOwner = admin.venueId === null && admin.businessId === null;
  const isManager = admin.businessId !== null;
  // Front desk runs the day; the money totals and the staff log are a manager's.
  const desk = admin.role === "desk";
  const tabs: [Tab, string][] = [
    ["bookings", "Bookings"],
    ["schedule", "Court schedule"],
    ["occupancy", "Occupancy"],
    ...(desk ? [] : ([["reports", "Reports"]] as [Tab, string][])),
    ["courts", "Courts & rates"],
    ["classes", "Classes"],
    ["tournaments", "Tournaments"],
    ["leagues", "Leagues"],
    ["credit", "Credit & passes"],
    ["venues", isOwner ? "Venues & staff" : isManager ? "Branches & staff" : "Venue details"],
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Admin dashboard</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {admin.name} ·{" "}
            {isOwner ? (
              <span className="font-medium text-teal-700">Platform owner — all venues</span>
            ) : isManager && venues.length > 1 ? (
              <span className="font-medium text-teal-700">
                {admin.businessName} · {venues.length} branches
              </span>
            ) : (
              <span className="font-medium text-teal-700">
                {venues[0]?.name ?? "Your venue"}
                {desk && <span className="ml-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">Front desk</span>}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-col items-end">
          <button
            onClick={signOut}
            className="inline-flex min-h-9 items-center rounded-md px-2 text-sm text-slate-500 underline hover:text-teal-700"
          >
            Sign out
          </button>
          <ChangePassword endpoint="/api/admin/auth/password" />
        </div>
      </div>

      {twoFactor && (
        <details className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm">
          <summary className="cursor-pointer font-medium text-slate-700">
            Two-factor sign-in: {twoFactor.enabled ? "on" : "off"}
          </summary>
          <div className="mt-2">
            <TwoFactorPanel status={twoFactor} onChange={setTwoFactor} />
          </div>
        </details>
      )}

      {isOwner && <SystemHealth />}
      {isOwner && <ErrorsPanel />}
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
          No venues yet. Create one in the{" "}
          <button onClick={() => setTab("venues")} className="font-medium text-teal-700 underline">
            Venues &amp; staff
          </button>{" "}
          tab.
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
