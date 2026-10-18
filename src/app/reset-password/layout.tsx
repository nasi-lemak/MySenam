import type { Metadata } from "next";

// The address carries the reset token: never pass it on to another site.
export const metadata: Metadata = { referrer: "no-referrer", robots: { index: false } };

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
