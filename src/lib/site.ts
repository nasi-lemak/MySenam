/**
 * What this install calls itself.
 *
 * The same code runs as the MySenam marketplace and as a venue's own booking
 * site under its own name, so the name is configuration: SITE_NAME, read on
 * the server and handed to the browser with the language. Every phrase that
 * names the site says `{site}`, which the translator fills in.
 */
export const DEFAULT_SITE_NAME = "MySenam";

export function siteName(): string {
  const configured = typeof process !== "undefined" ? process.env.SITE_NAME : undefined;
  return configured?.trim() || DEFAULT_SITE_NAME;
}
