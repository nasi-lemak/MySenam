"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
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
 * just has no business implying otherwise. For the same reason the way in for
 * staff is in the footer, not here: "Admin" in a customer's header means
 * nothing to them.
 *
 * On a phone it is one row — the name, finding a court, signing in — with the
 * rest behind a menu, rather than three wrapped rows covering a sixth of the
 * screen on every page.
 */
export default function SiteNav({ listVenue = false }: { listVenue?: boolean }) {
  const t = useT();
  const pathname = usePathname() ?? "";
  const onDashboard = pathname.startsWith("/admin");
  const [open, setOpen] = useState(false);

  // A tap on a link in the menu goes somewhere; the menu should not follow.
  useEffect(() => setOpen(false), [pathname]);

  if (onDashboard)
    return (
      <nav className="flex items-center text-sm font-medium text-slate-600">
        <LanguageToggle />
      </nav>
    );

  const links = [
    { href: "/", label: t("nav.venues") },
    { href: "/search", label: t("nav.find") },
    { href: "/classes", label: t("nav.classes") },
    { href: "/games", label: t("nav.games") },
    { href: "/my-booking", label: t("nav.myBooking") },
  ];

  return (
    <nav className="flex items-center gap-x-1 text-sm font-medium text-slate-600">
      {/* Wide screens: everything in one row. */}
      <div className="hidden items-center gap-x-1 sm:flex">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className={ITEM}>
            {l.label}
          </Link>
        ))}
        {listVenue && (
          <Link
            href="/list-your-venue"
            className="ml-1 inline-flex min-h-9 items-center rounded-full border border-slate-300 px-3 transition hover:border-teal-600 hover:text-teal-700"
          >
            {t("nav.listVenue")}
          </Link>
        )}
        <AuthNav />
        <LanguageToggle />
      </div>

      {/* Phones: the one thing most people came for, signing in, and a menu. */}
      <div className="flex items-center gap-x-1 sm:hidden">
        <Link href="/search" className={ITEM}>
          {t("nav.find")}
        </Link>
        <AuthNav />
        <button
          type="button"
          aria-expanded={open}
          aria-controls="site-menu"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border border-slate-300 px-2"
        >
          <span aria-hidden>{open ? "✕" : "☰"}</span>
          <span className="sr-only">{t("nav.menu")}</span>
        </button>
      </div>
      {open && (
        <div
          id="site-menu"
          className="absolute inset-x-0 top-full border-b border-slate-200 bg-white px-4 py-2 shadow-sm sm:hidden"
        >
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={`${ITEM} w-full`}>
              {l.label}
            </Link>
          ))}
          {listVenue && (
            <Link href="/list-your-venue" className={`${ITEM} w-full`}>
              {t("nav.listVenue")}
            </Link>
          )}
          <div className="py-1">
            <LanguageToggle />
          </div>
        </div>
      )}
    </nav>
  );
}
