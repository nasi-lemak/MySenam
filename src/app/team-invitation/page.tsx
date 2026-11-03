"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { sportLabel, translateError } from "@/lib/i18n";

type Preview = { team: string; sport: string; by: string; canActFor: { participantId: number; name: string }[] };

/**
 * Where an invitation to a team lands (lib/teams.ts). Accepting needs an account that has said it is an adult, signed in
 * (for an invitation by email, with the address it was sent to); somebody signed out is sent to sign in and comes back
 * here. A guardian may put somebody they look after on the team instead of themself. Accepting waits for a deliberate tap.
 */
export default function TeamInvitationPage() {
  const t = useT();
  const [token, setToken] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [who, setWho] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [gender, setGender] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ teamId: number; name: string } | null>(null);

  useEffect(() => {
    const tok = new URLSearchParams(window.location.search).get("token") ?? "";
    setToken(tok);
    void fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => readJson(r))
      .then(async (me: { user?: unknown }) => {
        setSignedIn(Boolean(me?.user));
        if (me?.user && tok) {
          const res = await fetch(`/api/team-invitations?token=${encodeURIComponent(tok)}`, { cache: "no-store" });
          const data = await readJson(res);
          if (res.ok) setPreview(data.invitation);
          else setError(translateError(t, data) || data.error);
        }
      })
      .catch(() => setSignedIn(false));
  }, [t]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/team-invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...(who ? { participantId: Number(who) } : {}), birthDate: birthDate || undefined, gender: gender || undefined }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(translateError(t, data) || data.error);
      setDone(data.team);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("err.TM_INVITE_INVALID"));
    } finally {
      setBusy(false);
    }
  }

  const back = token ? `/team-invitation?token=${encodeURIComponent(token)}` : "/team-invitation";
  const link = "block w-full rounded-lg bg-teal-600 py-2.5 text-center font-semibold text-white hover:bg-teal-700";
  const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <div className="mx-auto max-w-sm space-y-6">
      <h1 className="text-2xl font-bold">{t("tm.inv.title")}</h1>
      {token === null || signedIn === null ? null : token === "" ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{t("tm.inv.noToken")}</p>
      ) : done ? (
        <div className="space-y-4">
          <p role="status" className="rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm text-teal-800">
            {t("tm.inv.joined", { team: done.name })}
          </p>
          <a href={`/teams/${done.teamId}`} className={link}>
            {t("tm.inv.open")}
          </a>
        </div>
      ) : signedIn ? (
        <div className="space-y-4">
          {preview ? (
            <>
              <p className="text-sm text-slate-600">{t("tm.inv.intro", { by: preview.by, team: preview.team, sport: sportLabel(t, preview.sport) })}</p>
              {preview.canActFor.length > 0 && (
                <label className="flex flex-col text-xs text-slate-500">
                  {t("tm.inv.forChild")}
                  <select value={who} onChange={(e) => setWho(e.target.value)} className={input} name="who">
                    <option value="">{t("tm.inv.me")}</option>
                    {preview.canActFor.map((p) => (
                      <option key={p.participantId} value={p.participantId}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {who && <p className="text-xs text-slate-500">{t("tm.inv.childNote")}</p>}
              <div className="flex flex-wrap gap-2">
                <label className="flex flex-col text-xs text-slate-500">
                  {t("tm.ui.dob")}
                  <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} className={input} name="birthDate" />
                </label>
                <label className="flex flex-col text-xs text-slate-500">
                  {t("tm.ui.gender")}
                  <select value={gender} onChange={(e) => setGender(e.target.value)} className={input} name="gender">
                    <option value="">{t("tm.ui.genderNone")}</option>
                    <option value="woman">{t("tm.ui.woman")}</option>
                    <option value="man">{t("tm.ui.man")}</option>
                  </select>
                </label>
              </div>
              <p className="text-xs text-slate-500">{t("tm.ui.dobNote")}</p>
              <button onClick={accept} disabled={busy} className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
                {t("tm.inv.accept")}
              </button>
            </>
          ) : null}
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">{t("tm.inv.signIn")}</p>
          <a href={`/login?next=${encodeURIComponent(back)}`} className={link}>
            {t("nav.signIn")}
          </a>
        </div>
      )}
    </div>
  );
}
