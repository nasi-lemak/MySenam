"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import AuthNav from "@/components/AuthNav";
import { LanguageToggle, useT } from "@/components/Language";

/**
 * Every tap target here clears 24×24 CSS pixels (WCAG 2.2 AA, 2.5.8). Text
 * links default to the height of their line, which on a phone is about twenty
 * — fine to read and awkward to hit, which is the kind of thing nobody
 * notices on a mouse.
 */
const ITEM = "inline-flex min-h-9 items-center rounded-md px-2 transition hover:text-teal-700";

/**
 * The customer's navigation.
 *
 * Hidden on the dashboard: a member of staff working the counter has no use
 * for "Find a court", and being shown "Sign in" while already signed in as an
 * operator reads as a bug. The two are genuinely different logins — the header
 * just has no business implying otherwise.
 */
export default function SiteNav() {
  const t = useT();
  const onDashboard = (usePathname() ?? "").startsWith("/admin");

  return (
    <nav className="flex flex-wrap items-center justify-end gap-x-1 gap-y-1 text-sm font-medium text-slate-600">
      {!onDashboard && (
        <>
          <Link href="/" className={ITEM}>
            {t("nav.venues")}
          </Link>
          <Link href="/search" className={ITEM}>
            {t("nav.find")}
          </Link>
          <Link href="/classes" className={ITEM}>
            {t("nav.classes")}
          </Link>
          <Link href="/my-booking" className={ITEM}>
            {t("nav.myBooking")}
          </Link>
          <Link
            href="/admin"
            className="ml-1 inline-flex min-h-9 items-center rounded-full border border-slate-300 px-3 transition hover:border-teal-600 hover:text-teal-700"
          >
            {t("nav.admin")}
          </Link>
          <AuthNav />
        </>
      )}
      <LanguageToggle />
    </nav>
  );
}
