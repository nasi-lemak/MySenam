import type { Metadata } from "next";

// The address carries the invitation's token: never pass it on to another site.
export const metadata: Metadata = { referrer: "no-referrer", robots: { index: false } };

export default function GuestInvitationLayout({ children }: { children: React.ReactNode }) {
  return children;
}
