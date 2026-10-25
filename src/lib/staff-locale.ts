import { currentLocale, currentSiteName } from "./locale";
import { staffLocale, staffTranslator, type StaffT } from "./staff-i18n";

/** The staff dashboard's lookup for this request, for a server component. */
export async function staffServerT(): Promise<StaffT> {
  return staffTranslator(staffLocale(await currentLocale()), await currentSiteName());
}
