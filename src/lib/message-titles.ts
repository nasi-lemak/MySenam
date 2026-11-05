import { sportLabel, type T } from "./i18n";
import { shortDate } from "./region";
import type { ContextInfo, SeatLabel } from "./message-contexts";

/**
 * How a context and a sender are written in a reader's language (docs/features/player-messages.md). Shared by the page and the one
 * email, which says where a message is and never what it says.
 */
export type ContextTitleInfo = Pick<ContextInfo, "kind" | "name" | "sport" | "date" | "venueName">;

export function contextTitle(t: T, c: ContextTitleInfo): string {
  const name = c.name ?? "";
  switch (c.kind) {
    case "game":
      return t("pmsg.ctx.game", { sport: c.sport ? sportLabel(t, c.sport) : "", date: c.date ? shortDate(c.date, t.locale, true) : "", venue: c.venueName ?? "" });
    case "team":
      return t("pmsg.ctx.team", { name });
    case "group":
      return t("pmsg.ctx.group", { name });
    case "tournament_match":
      return t("pmsg.ctx.tournament_match", { name });
    case "league_match":
      return t("pmsg.ctx.league_match", { name });
    case "ladder_challenge":
      return t("pmsg.ctx.ladder_challenge", { name });
    case "team_fixture":
      return t("pmsg.ctx.team_fixture", { name });
  }
}

/** A sender as the context shows them: a first name, a guardian by the child's short name, or a team's captain; null once the account is gone. */
export function senderText(t: T, from: SeatLabel | null): string {
  if (!from) return t("pmsg.former");
  const names = (from.g ?? []).join(", ");
  if (from.c) return t("pmsg.from.captain", { team: from.c });
  if (from.n && names) return t("pmsg.from.nameGuardian", { name: from.n, names });
  if (names) return t("pmsg.from.guardian", { names });
  return from.n ?? t("pmsg.former");
}
