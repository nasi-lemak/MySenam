import type { Metadata } from "next";
import Link from "next/link";
import AuthNav from "@/components/AuthNav";
import { LanguageProvider, LanguageToggle } from "@/components/Language";
import { currentLocale, serverT } from "@/lib/locale";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return { title: t("meta.title"), description: t("meta.description") };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await currentLocale();
  const t = await serverT();

  return (
    <html lang={locale}>
      <body>
        <LanguageProvider locale={locale}>
          <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-y-2 px-4 py-3">
              <Link href="/" className="flex items-center gap-2 text-xl font-bold text-teal-700">
                <span aria-hidden>🏸</span>
                <span>
                  My<span className="text-slate-900">Senam</span>
                </span>
              </Link>
              {/* Wraps to a second line on a phone rather than pushing the page sideways. */}
              <nav className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 text-sm font-medium text-slate-600">
                <Link href="/" className="hover:text-teal-700">
                  {t("nav.venues")}
                </Link>
                <Link href="/search" className="hover:text-teal-700">
                  {t("nav.find")}
                </Link>
                <Link href="/classes" className="hover:text-teal-700">
                  {t("nav.classes")}
                </Link>
                <Link href="/my-booking" className="hover:text-teal-700">
                  {t("nav.myBooking")}
                </Link>
                <Link
                  href="/admin"
                  className="rounded-full border border-slate-300 px-3 py-1 hover:border-teal-600 hover:text-teal-700"
                >
                  {t("nav.admin")}
                </Link>
                <AuthNav />
                <LanguageToggle />
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
          <footer className="border-t border-slate-200 py-6 text-center text-sm text-slate-500">
            <p>{t("footer.tagline")}</p>
            <p className="mt-1.5">
              <Link href="/privacy" className="hover:text-teal-700 hover:underline">
                {t("footer.privacy")}
              </Link>
            </p>
          </footer>
        </LanguageProvider>
      </body>
    </html>
  );
}
