"use client";

import { readJson } from "@/lib/read-response";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import type { PhoneStatus } from "@/lib/phone-check";
import { region } from "@/lib/region";

/**
 * Add the account's phone number and check it — by sending us a message from
 * it on WhatsApp (recommended: nothing to receive, nothing to type), or with a
 * code by SMS — then back to whatever needed it. Where this install does not
 * check numbers, the number is simply saved.
 */
export default function PhonePage() {
  const t = useT();
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [wa, setWa] = useState<{ phone: string; link: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = (() => {
    if (typeof window === "undefined") return "/account";
    const n = new URLSearchParams(window.location.search).get("next");
    return n && n.startsWith("/") && !n.startsWith("//") ? n : "/account";
  })();

  // Waiting for the customer's WhatsApp message: on as soon as it arrives.
  useEffect(() => {
    if (!wa) return;
    const timer = setInterval(async () => {
      const res = await fetch("/api/my/phone", { cache: "no-store" });
      if (!res.ok) return;
      const s = (await readJson(res)) as PhoneStatus;
      if (s.verified) {
        clearInterval(timer);
        window.location.href = next;
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [wa, next]);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/my/phone", { cache: "no-store" });
      if (res.status === 401) return setSignedOut(true);
      const s = (await readJson(res)) as PhoneStatus;
      setStatus(s);
      setPhone(s.phone);
    })();
  }, []);

  async function post(body: object) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/my/phone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await readJson(res);
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
        <h1 className="text-2xl font-bold">{status.checks && !done ? t("phone.chooseTitle") : t("phone.title")}</h1>
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
      ) : wa ? (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-600">{t("phone.waStep", { phone: wa.phone })}</p>
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-center font-mono text-sm">{wa.text}</p>
          <a href={wa.link} target="_blank" rel="noopener noreferrer" className={`block text-center ${button} bg-[#25D366] hover:brightness-95`}>
            💬 {t("phone.waOpen")}
          </a>
          <p className="text-center text-xs text-slate-500" aria-live="polite">{t("phone.waWaiting")}</p>
          <button type="button" onClick={() => setWa(null)} className="text-sm text-slate-600 underline">
            {t("phone.back")}
          </button>
        </div>
      ) : sentTo === null ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await post({ action: "save", phone })) window.location.href = next;
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
              placeholder={region().phone.example}
              className={input}
            />
          </label>
          {!status.checks ? (
            <button disabled={busy} className={button}>
              {t("phone.save")}
            </button>
          ) : (
            <div className="space-y-2" role="group" aria-label={t("phone.chooseTitle")}>
              {status.methods?.whatsapp && (
                <button
                  type="button"
                  disabled={busy || phone.trim() === ""}
                  onClick={async () => {
                    const out = await post({ action: "whatsapp", phone });
                    if (out) setWa({ phone, link: out.link, text: out.text });
                  }}
                  className="w-full rounded-lg border-2 border-teal-600 bg-teal-50 p-3 text-left hover:bg-teal-100 disabled:opacity-50"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900">💬 {t("phone.viaWhatsapp")}</span>
                    <span className="rounded-full bg-teal-600 px-2 py-0.5 text-xs font-semibold text-white">{t("phone.recommended")}</span>
                  </span>
                  <span className="mt-1 block text-sm text-slate-600">{t("phone.viaWhatsappNote")}</span>
                </button>
              )}
              {status.methods?.code !== false && (
                <button
                  type="button"
                  disabled={busy || phone.trim() === ""}
                  onClick={async () => {
                    if (await post({ action: "send", phone })) setSentTo(phone);
                  }}
                  className="w-full rounded-lg border border-slate-300 p-3 text-left hover:border-teal-500 disabled:opacity-50"
                >
                  <span className="font-semibold text-slate-900">
                    {status.methods?.codeBy === "whatsapp" ? `🔢 ${t("phone.viaCodeWhatsapp")}` : `✉️ ${t("phone.viaSms")}`}
                  </span>
                  <span className="mt-1 block text-sm text-slate-600">
                    {status.methods?.codeBy === "whatsapp" ? t("phone.viaCodeWhatsappNote") : t("phone.viaSmsNote")}
                  </span>
                </button>
              )}
            </div>
          )}
        </form>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await post({ action: "confirm", code })) window.location.href = next;
          }}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <p className="text-sm text-slate-600">
            {status.methods?.codeBy === "whatsapp" ? t("phone.sent", { phone: sentTo }) : t("phone.smsSent", { phone: sentTo })}
          </p>
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
