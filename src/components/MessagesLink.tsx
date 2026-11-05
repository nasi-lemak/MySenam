"use client";

import Link from "next/link";
import { useT } from "./Language";

/**
 * The way into a conversation from the game, team, group or fixture it belongs to (docs/features/player-messages.md). It opens the
 * Messages page on that context; whether anybody there has messages on, and whether the reader does, is that page's to say, so this link
 * tells nobody who has. Shown only where the reader is already in the context.
 */
export function MessagesLink({ kind, id, what }: { kind: string; id: number; what: "game" | "team" | "group" | "match" }) {
  const t = useT();
  return (
    <Link href={`/messages?open=${kind}:${id}`} className="inline-flex min-h-8 items-center rounded-md border border-slate-200 px-2 py-0.5 text-xs font-semibold text-teal-700 hover:border-teal-400">
      {t("pmsg.open", { what: t(`pmsg.what.${what}`) })}
    </Link>
  );
}
