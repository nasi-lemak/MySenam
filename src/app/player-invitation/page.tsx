"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";

type Accepted = { kind: "game"; gameId: number; status: string } | { kind: "group"; groupId: number; name: string };

/**
 * Where an emailed invitation to an open game or a community group lands.
 * Accepting needs an account signed in with the address it was sent to:
 * somebody signed out is sent to sign in, or to make an account, and comes
 * back here. Accepting waits for a deliberate tap.
 */
export default function PlayerInvitationPage() {
  const t = useT();
  const [token, setToken] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Accepted | null>(null);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") ?? "");
    void fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((me: { user?: unknown }) => setSignedIn(Boolean(me?.user)))
      .catch(() => setSignedIn(false));
  }, []);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/player-invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("err.PLAYER_INVITATION_INVALID"));
      setDone(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("err.PLAYER_INVITATION_INVALID"));
    } finally {
      setBusy(false);
    }
  }

  const back = token ? `/player-invitation?token=${encodeURIComponent(token)}` : "/player-invitation";
  const link = "block w-full rounded-lg bg-teal-600 py-2.5 text-center font-semibold text-white hover:bg-teal-700";
  return (
    <div className="mx-auto max-w-sm space-y-6">
      <h1 className="text-2xl font-bold">{t("gi7.title")}</h1>
      {token === null || signedIn === null ? null : token === "" ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{t("gi7.noToken")}</p>
      ) : done ? (
        <div className="space-y-4">
          <p role="status" className="rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm text-teal-800">
            {done.kind === "group"
              ? t("gi7.groupJoined", { g: done.name })
              : done.status === "requested"
                ? t("gi7.asked")
                : done.status === "waitlisted"
                  ? t("gi7.waitlisted")
                  : t("gi7.joined")}
          </p>
          <a href={done.kind === "group" ? `/games/groups/${done.groupId}` : `/games?game=${done.gameId}`} className={link}>
            {t(done.kind === "group" ? "gi7.openGroup" : "gi7.openGame")}
          </a>
        </div>
      ) : signedIn ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">{t("gi7.intro")}</p>
          <button
            onClick={accept}
            disabled={busy}
            className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? t("gi7.accepting") : t("gi7.accept")}
          </button>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">{t("gi7.signedOut")}</p>
          <a href={`/login?next=${encodeURIComponent(back)}`} className={link}>
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
