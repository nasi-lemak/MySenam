import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import { LanguageProvider } from "@/components/Language";
import { currentLocale, currentSiteName, serverT } from "@/lib/locale";
import { accentCss, currentStorefront } from "@/lib/storefront";
import { baseUrl } from "@/lib/outbox";
import { DEFAULT_SITE_NAME, siteName } from "@/lib/site";
import { isMarketplace } from "@/lib/mode";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return { title: t("meta.title"), description: t("meta.description") };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await currentLocale();
  const t = await serverT();
  const storefront = await currentStorefront();
  const site = await currentSiteName();

  return (
    <html lang={locale}>
      <body>
        {storefront?.accentColor && (
          // Validated as #rrggbb when saved, and again when written out.
          <style dangerouslySetInnerHTML={{ __html: accentCss(storefront.accentColor) }} />
        )}
        <LanguageProvider locale={locale} site={site}>
          <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-y-2 px-4 py-3">
              <Link href="/" className="flex items-center gap-2 text-xl font-bold text-teal-700">
                {storefront?.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- any https host, sized here
                  <img src={storefront.logoUrl} alt="" className="h-8 w-auto max-w-[8rem] object-contain" />
                ) : (
                  <span aria-hidden>🏸</span>
                )}
                {site === DEFAULT_SITE_NAME ? (
                  <span>
                    My<span className="text-slate-900">Senam</span>
                  </span>
                ) : (
                  <span>{site}</span>
                )}
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
              <Link
                href="/terms"
                className="inline-flex min-h-9 items-center rounded-md px-2 hover:text-teal-700 hover:underline"
              >
                {t("footer.terms")}
              </Link>
              {isMarketplace() && !storefront && (
                <Link
                  href="/list-your-venue"
                  className="inline-flex min-h-9 items-center rounded-md px-2 hover:text-teal-700 hover:underline"
                >
                  {t("footer.listVenue")}
                </Link>
              )}
            </p>
            {storefront && (
              <p className="mt-1.5 text-xs text-slate-400">
                Bookings by{" "}
                <a href={baseUrl()} className="hover:text-teal-700 hover:underline">
                  {siteName()}
                </a>
              </p>
            )}
          </footer>
        </LanguageProvider>
      </body>
    </html>
  );
}
