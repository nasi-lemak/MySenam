"use client";

import { useState } from "react";
import { readJson } from "@/lib/read-response";
import { translateError } from "@/lib/i18n";
import type { T } from "@/lib/i18n";
import type { HoldPreviewView } from "@/lib/ladders";

/**
 * What a player is shown before they agree a time for a ladder challenge whose court the venue holds (docs/features/tournaments.md#court-time-held-by-the-venue-an-optional-setting-per-ladder,
 * ADR 0050): the court that would be held, the day, start and duration, what it costs (the hold is free and moves no money; the venue's own court hire terms apply), and
 * what it means (what releases it, what replaces it, what happens if the court becomes unavailable, what a later change that both did not agree does). The court is a
 * non-binding look at the one the deterministic choice would hold: it is reserved only if the hold itself succeeds.
 */
export type HoldLook = Extract<HoldPreviewView, { applies: true }>;

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function HoldAgreement({ t, look, kind, name }: { t: T; look: HoldLook; kind: "accept" | "agree_move" | "propose_move"; name: string }) {
  return (
    <section aria-label={t("lad4.ui.title")} className="space-y-1 rounded-lg border border-teal-200 bg-teal-50 p-3 text-sm">
      <h4 className="font-semibold">{t("lad4.ui.title")}</h4>
      <p className="font-medium">{t("lad4.ui.court", { court: look.court })}</p>
      <p className="text-xs text-slate-600">{t("lad4.ui.courtNote")}</p>
      <p>{t("lad4.ui.when", { date: look.date, time: hm(look.startMin), end: hm(look.endMin), minutes: look.minutes })}</p>
      {look.replaces && <p>{t("lad4.ui.replaces", { court: look.replaces.court, date: look.replaces.date, time: hm(look.replaces.startMin) })}</p>}
      <p>{t("lad4.ui.charges")}</p>
      <p>{t(look.effect === "confirmed" ? (kind === "propose_move" ? "lad4.ui.effect.askConfirmed" : "lad4.ui.effect.confirmed") : "lad4.ui.effect.tentative", { name })}</p>
      <p className="font-medium">{t("lad4.ui.implications")}</p>
      <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-700">
        <li>{t("lad4.ui.imp.release")}</li>
        <li>{t("lad4.ui.imp.booking")}</li>
        <li>{t("lad4.ui.imp.unavailable")}</li>
        <li>{t("lad4.ui.imp.change")}</li>
      </ul>
    </section>
  );
}

const button = "rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-40";
const plain = "rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-teal-500";

/**
 * The step before the act: ask for the look (`preview_hold`), show it, and only then offer the act itself, which carries the court the player was shown (it is held,
 * or nothing is). Where no court would be held (a day alone is not a time) there is nothing to show and the act is made straight away. A refusal is shown as the act's own
 * would be, and nothing has been held.
 */
export function AgreeAfterLook({
  t,
  url,
  kind,
  name,
  when,
  check,
  go,
  onGo,
}: {
  t: T;
  url: string;
  kind: "accept" | "agree_move" | "propose_move";
  name: string;
  /** The day and start for `propose_move`; `accept` and `agree_move` use the time the other side proposed. */
  when?: { onDate: string; minute: number };
  check: string;
  go: string;
  onGo: (courtId: number | null) => Promise<boolean>;
}) {
  const [state, setState] = useState<"idle" | "looking" | "shown">("idle");
  const [look, setLook] = useState<HoldLook | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function ask() {
    setProblem(null);
    setState("looking");
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "preview_hold", for: kind, ...(when ? { onDate: when.onDate, minute: when.minute } : {}) }) });
    const out = await readJson(res);
    if (!res.ok) {
      setProblem(translateError(t, out) || out.error || "");
      return setState("idle");
    }
    const preview = out.preview as HoldPreviewView | undefined;
    if (!preview || !preview.applies) {
      setState("idle");
      await onGo(null);
      return;
    }
    setLook(preview);
    setState("shown");
  }

  return (
    <div className="space-y-2">
      {state !== "shown" && (
        <button className={kind === "accept" || kind === "agree_move" ? button : plain} disabled={state === "looking"} onClick={() => void ask()}>
          {state === "looking" ? t("lad4.ui.checking") : check}
        </button>
      )}
      {problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
      {state === "shown" && look && (
        <>
          <HoldAgreement t={t} look={look} kind={kind} name={name} />
          <div className="flex flex-wrap gap-2">
            <button className={button} onClick={() => void onGo(look.courtId).then((done) => done || setState("idle"))}>
              {go}
            </button>
            <button className={plain} onClick={() => setState("idle")}>
              {t("lad4.ui.notNow")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
