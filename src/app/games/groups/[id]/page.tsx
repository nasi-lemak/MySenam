"use client";

import { readJson } from "@/lib/read-response";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { ActivityGlyph } from "@/components/Glyph";
import { sportLabel, translateError } from "@/lib/i18n";
import type { Group } from "@/lib/groups";
import { MessagesLink } from "@/components/MessagesLink";
import { YouthGroupPanel } from "@/components/YouthGroupPanel";

/** One community group: asking to join or answering an invitation; for its organiser, who is in and who is asking. */
export default function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useT();
  const [group, setGroup] = useState<Group | null>(null);
  const [missing, setMissing] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/groups/${id}`, { cache: "no-store" });
    if (!res.ok) return setMissing(true);
    const data = await readJson(res);
    setGroup(data.group);
    setSignedIn(Boolean(data.signedIn));
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(url: string, body: object, done?: string) {
    setError(null);
    setNotice(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await readJson(res);
    if (!res.ok) return setError(translateError(t, data) || data.error);
    if (done) setNotice(done);
    await load();
  }

  if (missing) return <p className="text-slate-500">{t("groups.none")}</p>;
  if (!group) return null;
  const organiser = group.mine?.role === "organiser" && group.mine.status === "member";
  const small = "rounded-md border border-slate-300 px-2 py-0.5 text-xs font-medium hover:border-teal-500";
  const button = "rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700";

  return (
    <div className="max-w-2xl space-y-5">
      <Link href="/games/groups" className="text-sm text-teal-700 underline">
        ← {t("groups.title")}
      </Link>
      <div>
        <h1 className="text-2xl font-bold">
          <ActivityGlyph sport={group.sport} /> {group.name}
        </h1>
        <p className="text-sm text-slate-600">
          {sportLabel(t, group.sport)}
          {group.area && ` · ${group.area}`} · {t("groups.members", { n: group.members })} · {t("groups.organiser")}: {group.organiserName}
        </p>
        {group.description && <p className="mt-2 text-sm">{group.description}</p>}
      </div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

      {!signedIn ? (
        <Link href={`/login?next=/games/groups/${group.id}`} className={button}>
          {t("games.signInToJoin")}
        </Link>
      ) : !group.mine || ["left", "declined"].includes(group.mine.status) ? (
        group.status === "active" && (
          <button onClick={() => void post(`/api/groups/${group.id}`, { action: "join" })} className={button}>
            {t("groups.ask")}
          </button>
        )
      ) : group.mine.status === "requested" ? (
        <p className="text-sm text-slate-600">{t("groups.asked")}</p>
      ) : group.mine.status === "invited" ? (
        <div className="flex items-center gap-3 text-sm">
          {t("groups.invited")}
          <button onClick={() => void post(`/api/groups/${group.id}`, { action: "join" })} className={button}>
            {t("groups.join")}
          </button>
          <button onClick={() => void post(`/api/groups/${group.id}`, { action: "leave" })} className="underline">
            {t("games.declineInvite")}
          </button>
        </div>
      ) : (
        group.mine.status === "member" &&
        !organiser && (
          <button onClick={() => void post(`/api/groups/${group.id}`, { action: "leave" })} className={small}>
            {t("groups.leave")}
          </button>
        )
      )}

      {group.mine?.status === "member" && group.status === "active" && <MessagesLink kind="group" id={group.id} what="group" />}

      {group.roster && (
        <ul className="space-y-1 rounded-xl border border-slate-200 bg-white p-3 text-sm" data-testid="roster">
          {group.roster.map((m) => (
            <li key={m.memberId} className="flex flex-wrap items-center gap-2">
              <span>
                {m.name} ·{" "}
                {m.role === "organiser"
                  ? t("groups.organiser")
                  : m.status === "requested"
                    ? t("groups.wants")
                    : m.status === "invited"
                      ? t("games.status.invited")
                      : t("groups.member")}
              </span>
              {organiser && m.role !== "organiser" && m.status === "requested" && (
                <>
                  <button onClick={() => void post(`/api/groups/${group.id}/members/${m.memberId}`, { action: "accept" })} className={small}>
                    {t("games.accept")}
                  </button>
                  <button onClick={() => void post(`/api/groups/${group.id}/members/${m.memberId}`, { action: "decline" })} className={small}>
                    {t("games.decline")}
                  </button>
                </>
              )}
              {organiser && m.role !== "organiser" && m.status !== "requested" && (
                <button onClick={() => void post(`/api/groups/${group.id}/members/${m.memberId}`, { action: "remove" })} className={small}>
                  {t("games.remove")}
                </button>
              )}
            </li>
          ))}
          {/* Invited by email: nothing about who until they accept; the organiser withdraws one on a confirm, until then. */}
          {(group.emailInvites ?? []).map((x) => (
            <li key={`email-${x.id}`} className="flex flex-wrap items-center gap-2 text-slate-500" data-testid="email-invite">
              <span>{x.withdrawn ? t("rv7.withdrawnEmail") : t("gi7.invitedEmail")}</span>
              {organiser && !x.withdrawn && (
                <button
                  onClick={() =>
                    window.confirm(t("rv7.withdrawConfirm")) &&
                    void post(`/api/groups/${group.id}`, { action: "withdrawInvitation", invitationId: x.id }, t("rv7.withdrawnOk"))
                  }
                  className={small}
                >
                  {t("rv7.withdraw")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {organiser && group.status === "active" && (
        <div className="space-y-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void post(`/api/groups/${group.id}`, { action: "invite", email }, t("games.inviteSent")).then(() => setEmail(""));
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <input type="email" required placeholder={t("games.inviteEmail")} aria-label={t("games.inviteEmail")} value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-sm" name="groupInviteEmail" />
            <button className={small}>{t("games.invite")}</button>
          </form>
          <button onClick={() => void post(`/api/groups/${group.id}`, { action: "close" })} className={`${small} text-red-700`}>
            {t("groups.close")}
          </button>
          <YouthGroupPanel groupId={group.id} />
        </div>
      )}
    </div>
  );
}
