"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useT } from "@/components/Language";
import { reportError } from "@/components/ErrorReporter";

/**
 * A page that failed while drawing: said plainly, reported (lib/error-log.ts)
 * so the owner sees it with its stack, and a way to try again.
 */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();
  useEffect(() => {
    // A failure on the server is filed there already, under its digest; this is one in the browser.
    if (!error.digest) reportError(error);
  }, [error]);
  return (
    <div className="mx-auto max-w-sm rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
      <div className="text-4xl" aria-hidden="true">
        😵
      </div>
      <h1 className="mt-2 text-xl font-bold">{t("error.title")}</h1>
      <p className="mt-2 text-sm text-slate-600">{t("error.body")}</p>
      <div className="mt-5 flex gap-2">
        <button onClick={reset} className="flex-1 rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700">
          {t("error.retry")}
        </button>
        <Link href="/" className="flex-1 rounded-lg border border-slate-300 py-2.5 font-semibold text-slate-700 hover:bg-slate-50">
          {t("error.home")}
        </Link>
      </div>
    </div>
  );
}
