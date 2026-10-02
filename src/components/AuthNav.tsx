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

  if (!loaded) return <span className="inline-block min-h-9 w-16" />;

  if (!user) {
    return (
      <Link
        href="/login"
        className="inline-flex min-h-9 items-center rounded-full bg-teal-600 px-3 text-white transition hover:bg-teal-700"
      >
        {t("nav.signIn")}
      </Link>
    );
  }

  return (
    <Link
      href="/account"
      className="inline-flex min-h-9 items-center rounded-full bg-teal-50 px-3 font-semibold text-teal-700 transition hover:bg-teal-100"
    >
      👤 {user.name.split(" ")[0]}
    </Link>
  );
}
