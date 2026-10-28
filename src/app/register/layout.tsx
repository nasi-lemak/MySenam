import type { Metadata } from "next";

// The address carries the sign-up token: never pass it on to another site.
export const metadata: Metadata = { referrer: "no-referrer", robots: { index: false } };

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return children;
}
