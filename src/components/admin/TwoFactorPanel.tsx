"use client";

import { useState } from "react";
import type { TwoFactorStatus } from "@/lib/two-factor";

/**
 * This staff account's two-factor sign-in: set up with an authenticator app,
 * recovery codes shown once, and turned off again where the install allows.
 */
export function TwoFactorPanel({ status, onChange }: { status: TwoFactorStatus; onChange: (s: TwoFactorStatus) => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(body: object) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/auth/two-factor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      return null;
    } finally {
      setBusy(false);
    }
  }

  const input = "w-28 rounded-md border border-slate-300 px-2 py-1 text-center font-mono tracking-widest";
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">Two-factor sign-in</h3>
      {recovery ? (
        <div className="mt-2 space-y-2">
          <p className="text-emerald-700">
            On. Keep these recovery codes somewhere safe: each signs you in once if you lose your phone. They are not
            shown again.
          </p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-5">
            {recovery.map((c) => (
              <li key={c} className="rounded bg-slate-50 px-2 py-1">
                {c}
              </li>
            ))}
          </ul>
          <button onClick={() => setRecovery(null)} className="text-xs font-semibold text-teal-700 underline">
            I have saved them
          </button>
        </div>
      ) : status.enabled ? (
        <div className="mt-2 space-y-2">
          <p className="text-slate-600">
            On since {status.enabledAt?.slice(0, 10)}. {status.recoveryLeft} recovery codes left.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Code" inputMode="numeric" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} className={input} />
            <button
              disabled={busy || !code}
              onClick={async () => {
                const d = await post({ action: "renew", code });
                if (d) {
                  setRecovery(d.recoveryCodes);
                  setCode("");
                }
              }}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
            >
              New recovery codes
            </button>
            {!status.required && (
              <button
                disabled={busy || !code}
                onClick={async () => {
                  const d = await post({ action: "disable", code });
                  if (d) {
                    onChange(d.status);
                    setCode("");
                  }
                }}
                className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 disabled:opacity-50"
              >
                Turn off
              </button>
            )}
          </div>
          <p className="text-xs text-slate-500">Either needs a code from your app (or a recovery code).</p>
        </div>
      ) : setup ? (
        <div className="mt-2 space-y-2">
          <p className="text-slate-600">Scan this with your authenticator app, then type the six digits it shows.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} />
          <p className="text-xs text-slate-500">
            Or type this key into it: <span className="font-mono">{setup.secret.match(/.{1,4}/g)?.join(" ")}</span>
          </p>
          <div className="flex items-center gap-2">
            <input aria-label="Code" inputMode="numeric" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} className={input} />
            <button
              disabled={busy || code.length < 6}
              onClick={async () => {
                const d = await post({ action: "confirm", code });
                if (d) {
                  setRecovery(d.recoveryCodes);
                  setSetup(null);
                  setCode("");
                  onChange(d.status);
                }
              }}
              className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              Turn on
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-slate-600">
            {status.required
              ? "This site requires it for your account: set it up to carry on."
              : "A code from an app on your phone as well as your password, so a stolen password is not enough."}
          </p>
          <button
            disabled={busy}
            onClick={async () => {
              const d = await post({ action: "start" });
              if (d) setSetup({ secret: d.secret, qr: d.qr });
            }}
            className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            Set up two-factor sign-in
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
    </section>
  );
}
