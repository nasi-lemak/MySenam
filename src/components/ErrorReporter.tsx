"use client";

import { useEffect } from "react";

/** At most this many reports from one page, however broken it is. */
const MAX_REPORTS = 5;
let sent = 0;

/** Tell the server about an error in this browser (app/api/errors). Never throws. */
export function reportError(err: unknown) {
  if (sent >= MAX_REPORTS) return;
  sent++;
  try {
    const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Unhandled rejection");
    const body = JSON.stringify({ name: e.name, message: e.message, stack: e.stack, path: window.location.pathname });
    if (!navigator.sendBeacon?.("/api/errors", new Blob([body], { type: "application/json" })))
      void fetch("/api/errors", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true });
  } catch {
    // Reporting must never be the next error.
  }
}

/** Listens for errors nothing else caught, in every page, and reports them. */
export default function ErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => reportError(event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => reportError(event.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
