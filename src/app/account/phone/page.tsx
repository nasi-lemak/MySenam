"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import type { PhoneStatus } from "@/lib/phone-check";

/**
 * Add the account's phone number, and check it with a code sent to it on
 * WhatsApp; then back to whatever needed it. Where this install does not
 * check numbers, the number is simply saved.
 */
export default function PhonePage() {
  const t = useT();
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = (() => {
    if (typeof window === "undefined") return "/account";
    const n = new URLSearchParams(window.location.search).get("next");
    return n && n.startsWith("/") && !n.startsWith("//") ? n : "/account";
  })();

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/my/phone", { cache: "no-store" });
      if (res.status === 401) return setSignedOut(true);
      const s = (await res.json()) as PhoneStatus;
      setStatus(s);
      setPhone(s.phone);
    })();
  }, []);

  async function post(body: object) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/my/phone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) {
        setError(translateError(t, out) || out.error);
        return null;
      }
      setStatus(out.status);
      return out;
    } finally {
      setBusy(false);
    }
  }

  if (signedOut)
    return (
      <p className="text-slate-600">
        <Link href={`/login?next=/account/phone`} className="text-teal-700 underline">
          {t("nav.signIn")}
        </Link>
      </p>
    );
  if (!status) return null;
  const input = "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none";
  const button = "w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50";
  const done = status.phone !== "" && (status.verified || !status.checks);

  return (
    <div className="mx-auto max-w-sm space-y-5">
      <div>
        <h1 className="text-2xl font-bold">{t("phone.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">{status.checks ? t("phone.intro") : t("phone.introNoCheck")}</p>
      </div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {done && sentTo === null ? (
        <div className="space-y-4 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
          <p className="font-medium text-emerald-800">
            {status.phone} {status.verified && <span>✓ {t("phone.checked")}</span>}
          </p>
          <Link href={next} className={`block text-center ${button}`}>
            {t("phone.continue")}
          </Link>
          <button onClick={() => setStatus({ ...status, verified: false, phone: "" })} className="text-sm text-slate-600 underline">
            {t("phone.change")}
          </button>
        </div>
      ) : sentTo === null ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!status.checks) {
              if (await post({ action: "save", phone })) window.location.href = next;
              return;
            }
            if (await post({ action: "send", phone })) setSentTo(phone);
          }}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <label className="block text-sm font-medium text-slate-700">
            {t("phone.label")}
            <input
              required
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="012-345 6789"
              className={input}
            />
          </label>
          <button disabled={busy} className={button}>
            {status.checks ? t("phone.send") : t("phone.save")}
          </button>
        </form>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await post({ action: "confirm", code })) window.location.href = next;
          }}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <p className="text-sm text-slate-600">{t("phone.sent", { phone: sentTo })}</p>
          <label className="block text-sm font-medium text-slate-700">
            {t("phone.code")}
            <input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={`${input} text-center text-2xl tracking-[0.4em]`}
            />
          </label>
          <button disabled={busy} className={button}>
            {t("phone.check")}
          </button>
          <div className="flex justify-between text-sm">
            <button type="button" disabled={busy} onClick={() => void post({ action: "send", phone: sentTo })} className="text-teal-700 underline">
              {t("phone.again")}
            </button>
            <button
              type="button"
              onClick={() => {
                setSentTo(null);
                setCode("");
              }}
              className="text-slate-600 underline"
            >
              {t("phone.change")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
