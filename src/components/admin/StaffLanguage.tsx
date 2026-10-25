"use client";

import { useT } from "@/components/Language";
import { staffLocale, staffTranslator, type StaffT } from "@/lib/staff-i18n";

/**
 * The staff dashboard's lookup, for a client component: the language the site
 * is read in, if staff screens have it (English, Malay, Chinese), else the
 * install's first. The same object until the language changes.
 */
export function useStaffT(): StaffT {
  const t = useT();
  return staffTranslator(staffLocale(t.locale), t.site);
}
