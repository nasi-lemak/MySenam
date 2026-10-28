"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";

/**
 * Where a resident's emailed guest invitation lands. Accepting needs an
 * account signed in with the address it was sent to: somebody signed out is
 * sent to sign in, or to make an account, and comes back here. Accepting
 * waits for a deliberate tap.
 */
export default function GuestInvitationPage() {
  const t = useT();
  const [token, setToken] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ venue: { id: number; name: string }; expiresOn: string } | null>(null);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") ?? "");
    void fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => readJson(r))
      .then((me: { user?: unknown }) => setSignedIn(Boolean(me?.user)))
      .catch(() => setSignedIn(false));
  }, []);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/guest-invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(translateError(t, data) || t("err.GUEST_INVITATION_INVALID"));
      setDone(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("err.GUEST_INVITATION_INVALID"));
    } finally {
      setBusy(false);
    }
  }

  const back = token ? `/guest-invitation?token=${encodeURIComponent(token)}` : "/guest-invitation";
  return (
    <div className="mx-auto max-w-sm space-y-6">
      <h1 className="text-2xl font-bold">{t("gi6.title")}</h1>
      {token === null || signedIn === null ? null : token === "" ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{t("gi6.noToken")}</p>
      ) : done ? (
        <div className="space-y-4">
          <p role="status" className="rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm text-teal-800">
            {t("gi6.accepted", { venue: done.venue.name, until: done.expiresOn })}
          </p>
          <a
            href={`/venue/${done.venue.id}`}
            className="block w-full rounded-lg bg-teal-600 py-2.5 text-center font-semibold text-white hover:bg-teal-700"
          >
            {t("gi6.openVenue", { venue: done.venue.name })}
          </a>
        </div>
      ) : signedIn ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">{t("gi6.intro")}</p>
          <button
            onClick={accept}
            disabled={busy}
            className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? t("gi6.accepting") : t("gi6.accept")}
          </button>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">{t("gi6.signedOut")}</p>
          <a
            href={`/login?next=${encodeURIComponent(back)}`}
            className="block w-full rounded-lg bg-teal-600 py-2.5 text-center font-semibold text-white hover:bg-teal-700"
          >
            {t("gi6.signIn")}
          </a>
          <a
            href={`/login?mode=register&next=${encodeURIComponent(back)}`}
            className="block w-full rounded-lg border border-teal-300 py-2.5 text-center font-semibold text-teal-700 hover:bg-teal-50"
          >
            {t("gi6.register")}
          </a>
        </div>
      )}
    </div>
  );
}
