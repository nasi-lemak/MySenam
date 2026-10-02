import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import { LanguageProvider } from "@/components/Language";
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
              <SiteNav />
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
          <footer className="border-t border-slate-200 py-6 text-center text-sm text-slate-500">
            <p>{t("footer.tagline")}</p>
            <p className="mt-1.5">
              <Link
                href="/privacy"
                className="inline-flex min-h-9 items-center rounded-md px-2 hover:text-teal-700 hover:underline"
              >
                {t("footer.privacy")}
              </Link>
            </p>
          </footer>
        </LanguageProvider>
      </body>
    </html>
  );
}
