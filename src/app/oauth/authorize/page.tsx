"use client";

import { useEffect, useState } from "react";
import { useStaffT } from "@/components/admin/StaffLanguage";
import { readJson } from "@/lib/read-response";
import type { StaffPhrase } from "@/lib/staff-i18n";

/**
 * The consent page of the MCP server's sign-in (docs/integrations/mcp.md#signing-in-from-an-ai-assistant):
 * an AI assistant's connector sends a member of staff here. Signed in as
 * staff (two-factor sign-in honoured), they see the application by the name
 * it gave (not verified), where they go back to, the venue to allow (one, of
 * those they may manage) with their role there, and what each scope asked
 * for allows, and allow or deny. What front desk may not allow is shown and
 * cannot be ticked. Everything is checked again on the server
 * (`/api/oauth/authorize`); the decision is a JSON request from this page
 * only, and the browser goes back only to the address the application
 * registered.
 */

type Scope = "venue:read" | "venue:book" | "venue:configure";
interface Venue {
  id: number;
  name: string;
  role: "manager" | "desk";
  grantable: Scope[];
}
interface Loaded {
  request: { clientName: string; redirectHost: string; scopes: Scope[] };
  person: { name: string; email: string };
  venues: Venue[];
}

const SCOPE_PHRASE: Record<Scope, StaffPhrase> = { "venue:read": "oa.scope.read", "venue:book": "oa.scope.book", "venue:configure": "oa.scope.configure" };

export default function AuthorizePage() {
  const t = useStaffT();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "problem"; text: string } | { kind: "going"; text: string } | { kind: "ask"; data: Loaded }>({ kind: "loading" });
  const [venueId, setVenueId] = useState<number | null>(null);
  const [ticked, setTicked] = useState<Scope[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/oauth/authorize${window.location.search}`, { cache: "no-store" });
        const body = await readJson(res);
        if (body.problem) return setState({ kind: "problem", text: t(body.problem === "client" ? "oa.problem.client" : "oa.problem.redirect") });
        if (!res.ok) return setState({ kind: "problem", text: t.err(body, t("c.failed")) });
        if (body.redirect) {
          setState({ kind: "going", text: t("oa.going") });
          return window.location.replace(body.redirect);
        }
        if (body.signIn) {
          setState({ kind: "going", text: t("oa.signingIn") });
          return window.location.assign(body.signIn);
        }
        const data = body as Loaded;
        setState({ kind: "ask", data });
        const first = data.venues[0];
        if (first) {
          setVenueId(first.id);
          setTicked(data.request.scopes.filter((s) => first.grantable.includes(s)));
        }
      } catch (err) {
        setState({ kind: "problem", text: err instanceof Error ? err.message : t("c.failed") });
      }
    })();
  }, [t]);

  async function decide(decision: "allow" | "deny") {
    if (decision === "allow" && ticked.length === 0) return setError(t("oa.tickOne"));
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: window.location.search, decision, venueId, scopes: ticked }),
      });
      const body = await readJson(res);
      if (!res.ok || !body.redirect) throw new Error(t.err(body, t("c.failed")));
      setState({ kind: "going", text: t("oa.going") });
      window.location.assign(body.redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
      setBusy(false);
    }
  }

  if (state.kind !== "ask")
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-700" role={state.kind === "problem" ? "alert" : "status"}>
        {state.kind === "loading" ? t("c.loading") : state.text}
      </div>
    );

  const { request, person, venues } = state.data;
  const venue = venues.find((v) => v.id === venueId) ?? null;
  const choose = (id: number) => {
    const v = venues.find((x) => x.id === id);
    setVenueId(id);
    setTicked((now) => now.filter((s) => v?.grantable.includes(s)));
  };

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <h1 className="text-2xl font-bold">{t("oa.title")}</h1>
      <div className="space-y-1 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-700">
        <p className="text-base font-semibold text-slate-900">{t("oa.asks", { client: request.clientName, person: person.name })}</p>
        <p className="text-amber-800">{t("oa.unverified")}</p>
        <p>{t("oa.returnsTo", { host: request.redirectHost })}</p>
      </div>
      {venues.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm">{t("oa.noVenues")}</p>
      ) : (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 text-sm">
          <label className="block font-medium text-slate-800">
            {t("oa.venue")}
            <select
              value={venueId ?? ""}
              onChange={(e) => choose(Number(e.target.value))}
              className="mt-1 block min-h-9 w-full rounded-md border border-slate-300 px-2 py-1.5 font-normal"
            >
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          {venue && <p className="text-slate-600">{t(venue.role === "desk" ? "oa.roleDesk" : "oa.roleManager")}</p>}
          <fieldset className="space-y-2">
            <legend className="font-medium text-slate-800">{t("oa.may")}</legend>
            {request.scopes.map((s) => {
              const allowed = venue?.grantable.includes(s) ?? false;
              return (
                <label key={s} className={`flex min-h-8 items-start gap-2 ${allowed ? "" : "text-slate-500"}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5 h-5 w-5"
                    disabled={!allowed || busy}
                    checked={allowed && ticked.includes(s)}
                    onChange={(e) => setTicked((now) => (e.target.checked ? [...now, s] : now.filter((x) => x !== s)))}
                  />
                  <span>
                    {t(SCOPE_PHRASE[s])}
                    {!allowed && <span className="block text-xs font-medium">{t("oa.notForRole")}</span>}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <p className="text-xs text-slate-500">{t("oa.checks")}</p>
          {error && (
            <p role="alert" className="text-red-700">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy || venue === null}
              onClick={() => void decide("allow")}
              className="min-h-10 rounded-lg bg-teal-600 px-5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {t("oa.allow")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide("deny")}
              className="min-h-10 rounded-lg border border-slate-300 bg-white px-5 font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-50"
            >
              {t("oa.deny")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
