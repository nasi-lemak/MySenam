/**
 * A guest's name, phone and email, kept on their own device after they book,
 * so the next booking is two taps. Only in this browser, never sent anywhere
 * else, and gone with "Not you?". Storage can be missing or refuse (a private
 * window, blocked site data), so every touch is allowed to fail quietly.
 */

const KEY = "mysenam.guest";

export interface Guest {
  name: string;
  phone: string;
  email: string;
}

export function rememberedGuest(): Guest | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as Partial<Guest>;
    if (typeof g.name !== "string" || typeof g.phone !== "string") return null;
    return { name: g.name.slice(0, 80), phone: g.phone.slice(0, 20), email: typeof g.email === "string" ? g.email.slice(0, 120) : "" };
  } catch {
    return null;
  }
}

export function rememberGuest(g: Guest): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ name: g.name.trim(), phone: g.phone.trim(), email: g.email.trim() }));
  } catch {
    // Nowhere to keep it; they type it next time.
  }
}

export function forgetGuest(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}
