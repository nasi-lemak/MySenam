"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { User } from "@/lib/auth";
import { useT } from "@/components/Language";

export default function AuthNav() {
  const pathname = usePathname();
  const t = useT();
  const [user, setUser] = useState<User | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Refetch on every route change so the chip updates right after login/logout.
  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoaded(true));
  }, [pathname]);

  if (!loaded) return <span className="w-16" />;

  if (!user) {
    return (
      <Link
        href="/login"
        className="rounded-full bg-teal-600 px-3 py-1 text-white hover:bg-teal-700"
      >
        {t("nav.signIn")}
      </Link>
    );
  }

  return (
    <Link
      href="/account"
      className="rounded-full bg-teal-50 px-3 py-1 font-semibold text-teal-700 hover:bg-teal-100"
    >
      👤 {user.name.split(" ")[0]}
    </Link>
  );
}
