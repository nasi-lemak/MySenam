"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { PrintButton } from "@/components/PrintButton";
import type { StaffPhrase } from "@/lib/staff-i18n";
import { blockText, say, sayLink, type Speaker } from "@/lib/guide/playbook/render";
import type { Block, CalloutKind, GuideLink, Playbook, PlaybookSection } from "@/lib/guide/playbook/types";
import type { GuideRole } from "@/lib/guide/shell";
import { placeParam, setPlaceParams } from "../place";
import { useStaffT } from "../StaffLanguage";

/**
 * The operating playbook as a document (docs/features/venue-guide.md, "The
 * operating playbook"): a table of contents, a search box over the text
 * already loaded, collapsible sections, numbered steps, callouts with a word
 * label as well as a colour, screen links that open the dashboard tab, and a
 * print view (the browser's own Print to PDF: nothing is stored or uploaded).
 *
 * The dashboard's playbook view and the coach's page both render it, so a
 * guide reads the same wherever it is opened. It only draws what the
 * playbook holds: which links there are, and which words, was decided on the
 * server for the reader's role.
 */

const ROLE_PHRASES: Record<GuideRole, StaffPhrase> = {
  manager: "gd.role.manager",
  desk: "gd.role.desk",
  coach: "gd.role.coach",
};

const CALLOUT_LABEL: Record<CalloutKind, StaffPhrase> = {
  note: "gp.ui.label.note",
  warning: "gp.ui.label.warning",
  policy: "gp.ui.label.policy",
  scheduled: "gp.ui.label.scheduled",
};

/** A border and a word, never colour alone. */
const CALLOUT_STYLE: Record<CalloutKind, string> = {
  note: "border-slate-400 bg-slate-50",
  warning: "border-amber-500 bg-amber-50",
  policy: "border-teal-600 bg-teal-50",
  scheduled: "border-indigo-500 bg-indigo-50",
};

/**
 * Print: only the guide, on A4, every section open and every topic shown
 * whatever was folded or searched on screen, nothing split inside a step.
 */
const PRINT_CSS = `@media print {
  @page { size: A4; margin: 14mm; }
  body * { visibility: hidden; }
  [data-playbook-print], [data-playbook-print] * { visibility: visible; }
  [data-playbook-print] { position: absolute; left: 0; top: 0; width: 100%; padding: 0; font-size: 11pt; }
  [data-playbook-print] .playbook-controls { display: none !important; }
  [data-playbook-print] [data-section-body][hidden], [data-playbook-print] [data-group][hidden] { display: block !important; }
  [data-playbook-print] li, [data-playbook-print] aside, [data-playbook-print] tr, [data-playbook-print] dl > div { break-inside: avoid; }
  [data-playbook-print] h2, [data-playbook-print] h3, [data-playbook-print] h4 { break-after: avoid; }
  [data-playbook-print] h2 button { all: unset; }
  [data-playbook-print] a, [data-playbook-print] button { color: inherit; text-decoration: none; }
  [data-playbook-print] .playbook-link { display: none !important; }
}`;

interface Group {
  key: string;
  blocks: Block[];
  text: string;
}

function groupsOf(speaker: Speaker, section: PlaybookSection): Group[] {
  const groups: Group[] = [];
  for (const block of section.blocks) {
    if (block.type === "heading" && block.level === 3) groups.push({ key: block.id ?? `${section.id}-${groups.length}`, blocks: [], text: "" });
    if (groups.length === 0) groups.push({ key: `${section.id}-0`, blocks: [], text: "" });
    const g = groups[groups.length - 1];
    g.blocks.push(block);
    g.text += ` ${blockText(speaker, block).join(" ")}`.toLowerCase();
  }
  return groups;
}

export function PlaybookDocument({
  playbook,
  ownRole,
  roles,
  onViewAs,
  onGo,
}: {
  playbook: Playbook;
  /** The reader's own role, where they may preview another's: with `roles` and `onViewAs`. */
  ownRole?: GuideRole;
  roles?: GuideRole[];
  onViewAs?: (role: GuideRole) => void;
  /** Open a screen of the dashboard; not given where there is no dashboard (the coach's page). */
  onGo?: (link: GuideLink) => void;
}) {
  const t = useStaffT();
  const speaker: Speaker = useMemo(() => ({ t, locale: t.locale }), [t]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({ [playbook.sections[0]?.id ?? ""]: true }));
  const scrollTo = useRef<string | null>(null);

  const sections = useMemo(
    () => playbook.sections.map((s) => ({ section: s, title: say(speaker, s.title), groups: groupsOf(speaker, s) })),
    [playbook, speaker]
  );
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = words.length > 0;
  const hit = (g: Group, title: string) => words.every((w) => g.text.includes(w) || title.toLowerCase().includes(w));
  const matches = sections.map((s) => s.groups.filter((g) => hit(g, s.title)));
  const total = matches.reduce((n, m) => n + m.length, 0);

  // After a contents link opens its section, bring the target into view.
  useEffect(() => {
    const id = scrollTo.current;
    if (!id) return;
    scrollTo.current = null;
    document.getElementById(id)?.scrollIntoView?.({ block: "start" });
  });

  // "Open this in the guide" from a "?" beside a screen (`&topic=`): open the section that explains the topic and bring it into view,
  // once (the address forgets it, so a later visit starts where it always does). A topic the venue's guide has no section for is not there.
  // After the effect above, so the section is open when it looks for the target.
  useEffect(() => {
    const asked = placeParam("topic");
    if (!asked) return;
    setPlaceParams({ topic: null });
    const target = `topic-${asked}`;
    const section = playbook.sections.find((s) => s.blocks.some((b) => b.type === "heading" && b.id === target));
    if (!section) return;
    setOpen((o) => ({ ...o, [section.id]: true }));
    scrollTo.current = target;
    // Once, on the first draw of this guide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const jump = (sectionId: string, targetId: string) => {
    setQuery("");
    setOpen((o) => ({ ...o, [sectionId]: true }));
    scrollTo.current = targetId;
  };
  const allOpen = playbook.sections.every((s) => open[s.id]);
  const previewing = ownRole !== undefined && ownRole !== playbook.role;

  return (
    <div data-playbook-print data-role={playbook.role} className="space-y-4">
      <style>{PRINT_CSS}</style>

      {/* On paper only: whose guide this is, and from when. */}
      <div className="hidden print:block">
        <h1 className="text-xl font-bold">{playbook.role === "coach" ? t("gp.ui.coachTitle") : t("gp.heading")}</h1>
        {playbook.venue.name && <p className="text-base font-semibold">{playbook.venue.name}</p>}
        <p className="text-sm">{t("gp.ui.guideFor", { role: t(ROLE_PHRASES[playbook.role]) })}</p>
        <p className="text-sm">{t("gp.ui.printedOn", { date: playbook.venue.today })}</p>
      </div>

      <div className="playbook-controls flex flex-wrap items-end gap-3 print:hidden">
        {roles && roles.length > 1 && onViewAs && (
          <label className="flex items-center gap-2 text-sm">
            {t("gp.ui.viewAs")}
            <select value={playbook.role} onChange={(e) => onViewAs(e.target.value as GuideRole)} className="min-h-9 rounded-md border border-slate-300 px-2 py-1 text-sm">
              {roles.map((r) => (
                <option key={r} value={r}>
                  {t(ROLE_PHRASES[r])}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex min-w-0 flex-1 basis-56 items-end gap-2">
          <label className="min-w-0 flex-1 text-sm">
            <span className="block text-slate-700">{t("gp.ui.search")}</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="mt-0.5 min-h-9 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
            />
          </label>
          {searching && (
            <button type="button" onClick={() => setQuery("")} className="min-h-9 rounded-md border border-slate-300 px-3 text-sm hover:border-teal-400">
              {t("gp.ui.clear")}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen(Object.fromEntries(playbook.sections.map((s) => [s.id, !allOpen])))}
          className="min-h-9 rounded-md border border-slate-300 px-3 text-sm hover:border-teal-400"
        >
          {allOpen ? t("gp.ui.collapseAll") : t("gp.ui.expandAll")}
        </button>
        <PrintButton label={t("gp.ui.print")} />
      </div>

      {previewing && (
        <p role="note" data-preview className="rounded-lg border border-indigo-400 bg-indigo-50 px-3 py-2 text-sm print:hidden">
          <strong>{t("gp.ui.guideFor", { role: t(ROLE_PHRASES[playbook.role]) })}.</strong> {t("gp.ui.previewing", { role: t(ROLE_PHRASES[playbook.role]) })}
        </p>
      )}

      <div role="status" aria-live="polite" className="text-sm text-slate-600 print:hidden">
        {searching ? (total === 0 ? t("gp.ui.noResults") : t("gp.ui.results", { n: total })) : ""}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
        {playbook.venue.name && <p className="font-semibold">{playbook.venue.name}</p>}
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-700" data-summary>
          {playbook.summary.map((s, i) => (
            <li key={i}>{say(speaker, s)}</li>
          ))}
        </ul>
      </div>

      <nav aria-label={t("gp.ui.toc")} className="playbook-controls rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm print:hidden" data-toc>
        <p className="font-semibold">{t("gp.ui.toc")}</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          {playbook.toc.map((entry) => (
            <li key={entry.id}>
              <a
                href={`#gp-${entry.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  jump(entry.id, `gp-${entry.id}`);
                }}
                className="inline-block min-h-6 py-0.5 text-teal-700 underline"
              >
                {say(speaker, entry.title)}
              </a>
              {entry.items && entry.items.length > 0 && (
                <ul className="list-disc pl-5">
                  {entry.items.map((item) => (
                    <li key={item.id}>
                      <a
                        href={`#${item.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          jump(entry.id, item.id);
                        }}
                        className="inline-block min-h-6 py-0.5 text-teal-700 underline"
                      >
                        {say(speaker, item.title)}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </nav>

      {sections.map(({ section, title, groups }, si) => {
        const shown = searching ? matches[si] : groups;
        if (searching && shown.length === 0) return null;
        const isOpen = searching || open[section.id] === true;
        return (
          <section key={section.id} id={`gp-${section.id}`} data-section={section.id} aria-labelledby={`gp-h-${section.id}`} className="rounded-lg border border-slate-200 bg-white">
            <h2 id={`gp-h-${section.id}`} className="text-base font-semibold">
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={`gp-body-${section.id}`}
                title={t("gp.ui.sectionHint")}
                onClick={() => setOpen((o) => ({ ...o, [section.id]: !isOpen }))}
                className="flex min-h-10 w-full items-center justify-between gap-2 px-4 py-2 text-left"
              >
                <span>{title}</span>
                <span aria-hidden="true" className="text-slate-500 print:hidden">
                  {isOpen ? "−" : "+"}
                </span>
              </button>
            </h2>
            <div id={`gp-body-${section.id}`} data-section-body hidden={!isOpen} className="space-y-5 px-4 pb-4">
              {shown.map((g) => (
                <div key={g.key} data-group={g.key} className="space-y-2">
                  {g.blocks.map((b, i) => (
                    <BlockView key={i} block={b} speaker={speaker} onGo={onGo} />
                  ))}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function LinkButton({ link, speaker, onGo }: { link: GuideLink; speaker: Speaker; onGo?: (link: GuideLink) => void }) {
  if (!onGo) return null;
  return (
    <button
      type="button"
      onClick={() => onGo(link)}
      data-link-tab={link.tab}
      className="playbook-link min-h-8 rounded-md bg-teal-600 px-3 text-xs font-medium text-white hover:bg-teal-700 print:hidden"
    >
      {sayLink(speaker, link)}
    </button>
  );
}

/** One block of a guide or of a topic: the one renderer both the playbook and the contextual help use (HelpTip.tsx). */
export function BlockView({ block, speaker, onGo }: { block: Block; speaker: Speaker; onGo?: (link: GuideLink) => void }) {
  const t = speaker.t;
  switch (block.type) {
    case "heading": {
      const H = block.level === 3 ? "h3" : "h4";
      return (
        <H id={block.id} className={block.level === 3 ? "scroll-mt-4 border-b border-slate-200 pb-1 text-base font-semibold" : "scroll-mt-4 pt-2 text-sm font-semibold"}>
          {say(speaker, block.text)}
        </H>
      );
    }
    case "paragraph":
      return <p className="text-sm text-slate-700">{say(speaker, block.text)}</p>;
    case "steps":
      return (
        <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
          {block.items.map((item, i) => (
            <li key={i}>
              {say(speaker, item.text)}
              {item.link && onGo && (
                <div className="mt-1">
                  <LinkButton link={item.link} speaker={speaker} onGo={onGo} />
                </div>
              )}
            </li>
          ))}
        </ol>
      );
    case "facts":
      return (
        <dl className="space-y-1 text-sm">
          {block.items.map((item, i) => (
            <div key={i} className="grid gap-x-3 sm:grid-cols-[12rem_1fr]">
              <dt className="font-medium text-slate-800">{say(speaker, item.label)}</dt>
              <dd className="min-w-0 text-slate-700">
                {say(speaker, item.value)}
                {item.link && onGo && (
                  <Fragment>
                    {" "}
                    <LinkButton link={item.link} speaker={speaker} onGo={onGo} />
                  </Fragment>
                )}
              </dd>
            </div>
          ))}
        </dl>
      );
    case "callout":
      return (
        <aside role="note" data-callout={block.kind} className={`rounded-md border-l-4 px-3 py-2 text-sm ${CALLOUT_STYLE[block.kind]}`}>
          <p className="font-semibold">
            {t(CALLOUT_LABEL[block.kind])}
            {block.title ? `: ${say(speaker, block.title)}` : ""}
          </p>
          <p className="text-slate-800">{say(speaker, block.text)}</p>
        </aside>
      );
    case "link":
      return <LinkButton link={block.link} speaker={speaker} onGo={onGo} />;
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[20rem] border-collapse text-left text-sm">
            <thead>
              <tr>
                {block.head.map((h, i) => (
                  <th key={i} scope="col" className="border-b border-slate-300 px-2 py-1 font-semibold">
                    {say(speaker, h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="align-top">
                  {row.map((cell, j) => (
                    <td key={j} className="border-b border-slate-200 px-2 py-1 text-slate-700">
                      {say(speaker, cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}
