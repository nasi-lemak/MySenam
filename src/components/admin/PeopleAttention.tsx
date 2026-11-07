"use client";

import type { PeopleAttention as PeopleData } from "@/lib/people-attention";
import { money } from "@/lib/region";
import { useStaffT } from "./StaffLanguage";

/** How many lines the people block has, so the needs-attention panel knows whether it has anything to show. */
export function peopleLineCount(d: PeopleData | null | undefined): number {
  if (!d) return 0;
  const n = d.noShow;
  return (
    (n ? (n.answersWaiting > 0 ? 1 : 0) + (n.legacyPlatform > 0 ? 1 : 0) + n.hosts.length : 0) +
    (d.expiring.length > 0 ? 1 : 0) +
    (d.low.length > 0 ? 1 : 0) +
    (d.strikes.length > 0 ? 1 : 0) +
    (d.coaches.length > 0 ? 1 : 0)
  );
}

const EXPIRY_DAYS = 14;

/**
 * What staff should look at about people (lib/people-attention.ts, ADR 0072): players' answers to hosts' no-show marks waiting for a
 * decision (decided in the No-show marks panel, `NoShowMarksPanel`), passes, memberships and vouchers about to end, passes nearly used,
 * strikes and numbers at the limit, and coaches who cannot be told of their lessons.
 */
export function PeopleAttention({ data }: { data: PeopleData }) {
  const t = useStaffT();
  const n = data.noShow;
  return (
    <div className="mb-3 space-y-2 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-amber-900" data-testid="people-attention">
      <strong>{t("ppls.title")}</strong>
      {n && n.answersWaiting > 0 && <p>{t.plural("ppls.ns.answers", n.answersWaiting, { days: n.oldestWaitingDays })}</p>}
      {n && n.legacyPlatform > 0 && <p>{t.plural("ppls.ns.legacy", n.legacyPlatform)}</p>}
      {n?.hosts.map((h) => (
        <p key={h.hostId}>{t("ppls.ns.host", { name: h.name, marked: h.marked, reversed: h.reversed })}</p>
      ))}
      {n && (n.answersWaiting > 0 || n.legacyPlatform > 0 || n.hosts.length > 0) && <p className="text-xs">{t("ppls.ns.where")}</p>}
      {data.expiring.length > 0 && (
        <div data-testid="people-expiring">
          <p className="font-semibold">{t.plural("ppls.exp.title", data.expiring.length, { days: EXPIRY_DAYS })}</p>
          <ul className="mt-0.5 space-y-0.5 text-xs">
            {data.expiring.slice(0, 15).map((x) => (
              <li key={`${x.kind}${x.id}`}>
                {x.kind === "pass"
                  ? t("ppls.exp.pass", { code: x.code, what: x.what, holder: x.holder ?? "", left: x.left ?? 0, date: x.expiresOn, venue: x.venueName })
                  : x.kind === "membership"
                    ? t("ppls.exp.membership", { code: x.code, holder: x.holder ?? "", date: x.expiresOn, venue: x.venueName })
                    : t("ppls.exp.voucher", { code: x.code, amount: money(x.left ?? 0), date: x.expiresOn, venue: x.venueName })}{" "}
                {x.kind !== "voucher" && (x.told ? t("ppls.exp.told") : t("ppls.exp.notTold"))}
              </li>
            ))}
          </ul>
          <p className="mt-0.5 text-xs">{t("ppls.exp.help")}</p>
        </div>
      )}
      {data.low.length > 0 && (
        <div data-testid="people-low">
          <p className="font-semibold">{t.plural("ppls.low.title", data.low.length)}</p>
          <ul className="mt-0.5 space-y-0.5 text-xs">
            {data.low.slice(0, 15).map((x) => (
              <li key={x.id}>{t("ppls.low.line", { code: x.code, what: x.what, holder: x.holder ?? "", left: x.left, date: x.expiresOn, venue: x.venueName })}</li>
            ))}
          </ul>
        </div>
      )}
      {data.strikes.length > 0 && (
        <div data-testid="people-strikes">
          <p className="font-semibold">{t("ppls.str.title")}</p>
          <ul className="mt-0.5 space-y-0.5 text-xs">
            {data.strikes.slice(0, 20).map((x) => (
              <li key={`${x.venueId}-${x.phone}`}>
                {t("ppls.str.line", { name: x.name, phone: x.phone, strikes: x.strikes, limit: x.limit, venue: x.venueName, date: x.lastOn })}{" "}
                {x.out && <span className="font-semibold text-red-700">{t("ppls.str.out")}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.coaches.length > 0 && (
        <div data-testid="people-coaches">
          <p className="font-semibold">{t.plural("ppls.coach.title", data.coaches.length)}</p>
          <ul className="mt-0.5 space-y-0.5 text-xs">
            {data.coaches.map((c) => (
              <li key={c.coachId}>
                {t("ppls.coach.line", { coach: c.coach, venue: c.venueName, lessons: c.lessons, date: c.firstDate })} {c.hasLink && t("ppls.coach.link")}
              </li>
            ))}
          </ul>
          <p className="mt-0.5 text-xs">{t("ppls.coach.help")}</p>
        </div>
      )}
    </div>
  );
}
