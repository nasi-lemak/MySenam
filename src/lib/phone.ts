import { region } from "./region";

/**
 * A phone number as the digits that identify it, however it was typed:
 * "012-345 6789", "+60 12 345 6789" and "0123456789" are one Malaysian number;
 * "9123 4567" and "+65 9123 4567" one Singaporean. The same rule as the
 * database's `phone_key()` (migrations 0035, 0066), which keys bookings and lists.
 *
 * It needs no country: a Malaysian number written nationally starts with its
 * trunk 0, never 60, so 60 and ten or more digits is the international form;
 * a Singaporean number is eight digits, so 65 and eight more is the
 * international form and an eight-digit local number starting 65 is left be.
 */
export function phoneKey(phone: string): string {
  const raw = phone.replace(/\D/g, "");
  // 00 is how the international + is dialled.
  const d = raw.startsWith("00") ? raw.slice(2) : raw;
  if (d.startsWith("60") && d.length >= 10) return `0${d.slice(2)}`;
  if (d.startsWith("65") && d.length === 10) return d.slice(2);
  return d;
}

/**
 * A number with its country code, digits only, as WhatsApp, SMS gateways and
 * payment pages want it. A local number gets the install's country code
 * (`WHATSAPP_COUNTRY_CODE` overrides it), losing its trunk prefix if it has
 * one; one already written internationally is left as it is.
 */
export function internationalNumber(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);
  const { countryCode, trunk, minDigits } = region().phone;
  const country = (process.env.WHATSAPP_COUNTRY_CODE || countryCode).replace(/\D/g, "");
  if (trunk && digits.startsWith(trunk)) return country + digits.slice(trunk.length);
  // Already international: the country code and a whole local number after it.
  if (digits.startsWith(country) && digits.length >= country.length + minDigits) return digits;
  return country + digits;
}

/** Enough digits to be a phone number here, as typed locally or internationally. */
export function longEnough(phone: string): boolean {
  return phone.replace(/\D/g, "").length >= region().phone.minDigits;
}
