import { heading, note, para, step, steps, warning } from "../dsl";
import type { Block, GuideRole, PlaybookModule } from "../types";

const COACH: GuideRole[] = ["coach"];
const always = () => true;
const nn = (b: Block | null | false): b is Block => !!b;

/**
 * The coach's guide: their own lessons and schedule, their own hours and
 * days off, and what they may see, exactly as the coach's page
 * (/coach/<token>) already works (docs/features/programmes.md, "A coach's own
 * schedule"). Nothing about money and nothing about the venue's other
 * people: a coach has no staff account, so this guide has no dashboard link
 * and no manager instruction, and it is written from the profile only for
 * what is the venue's own (that it has coaching) and from `ctx.coach` for
 * what is the coach's own.
 */
export const COACH_MODULES: PlaybookModule[] = [
  {
    id: "coach.start",
    section: "coach",
    roles: COACH,
    applies: always,
    blocks: (c) => {
      const mine = c.ctx.coach;
      return [
        heading("gp.coach.start.h", "coach-start"),
        para("gp.coach.start.text"),
        mine ? para("gp.coach.start.lessons", { n: mine.lessonsAhead }) : null,
        mine ? para(mine.hoursSet ? "gp.coach.start.hoursSet" : "gp.coach.start.hoursNone") : null,
        warning("gp.coach.start.private"),
        para("gp.coach.start.link"),
      ].filter(nn);
    },
  },
  {
    id: "coach.schedule",
    section: "coach",
    roles: COACH,
    applies: always,
    blocks: () => [
      heading("gp.coach.schedule.h", "coach-schedule"),
      steps(step("gp.coach.schedule.s1"), step("gp.coach.schedule.s2"), step("gp.coach.schedule.s3"), step("gp.coach.schedule.s4")),
      para("gp.coach.schedule.changes"),
    ],
  },
  {
    id: "coach.hours",
    section: "coach",
    roles: COACH,
    applies: always,
    blocks: (c) => [
      heading("gp.coach.hours.h", "coach-hours"),
      steps(step("gp.coach.hours.s1"), step("gp.coach.hours.s2"), step("gp.coach.hours.s3")),
      c.ctx.coach && c.ctx.coach.timeOff > 0 ? para("gp.coach.hours.timeOff", { n: c.ctx.coach.timeOff }) : null,
      note("gp.coach.hours.booked"),
    ].filter(nn),
  },
  {
    id: "coach.language",
    section: "coach",
    roles: COACH,
    applies: always,
    blocks: () => [heading("gp.coach.language.h", "coach-language"), para("gp.coach.language.text")],
  },
  {
    id: "coach.privacy",
    section: "coach",
    roles: COACH,
    applies: always,
    blocks: () => [
      heading("gp.coach.privacy.h", "coach-privacy"),
      para("gp.coach.privacy.sees"),
      para("gp.coach.privacy.notSees"),
      para("gp.coach.privacy.reviews"),
    ],
  },
];
