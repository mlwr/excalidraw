/**
 * Notifications (Z3): someone mentioned me, answered in a thread I take part
 * in, or shared a scene or collection with me. Shown in the app (with a
 * live badge in open editors) and, if the company's SMTP relay is set up,
 * e-mailed after a short delay unless read in the app by then. Everyone
 * chooses which of them come by e-mail.
 *
 * Notifications hold no content (comments are encrypted): only who did
 * what where, with the names of scenes and collections.
 */
import { createTransport } from "nodemailer";
import { sql } from "kysely";

import type { AppContext } from "../context.js";
import type { Transporter } from "nodemailer";

export type NotificationType = "mention" | "reply" | "share";

export interface EmailPreferences {
  mention: boolean;
  reply: boolean;
  share: boolean;
}

export interface NotifyInput {
  type: NotificationType;
  userIds: string[];
  actor: { id: string; name: string };
  sceneId?: string | null;
  collectionId?: string | null;
  threadId?: string | null;
  data?: Record<string, unknown>;
}

const DEFAULT_EMAIL: EmailPreferences = {
  mention: true,
  reply: true,
  share: true,
};

/** recipients of a share to a group: only small teams, no mass mail */
export const MAX_GROUP_RECIPIENTS = 50;

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        char
      ]!),
  );

export const describeNotification = (row: {
  type: string;
  actor: string | null;
  data: Record<string, unknown>;
}) => {
  const who = row.actor || "Jemand";
  const scene = row.data.sceneName ? `„${row.data.sceneName}“` : null;
  switch (row.type) {
    case "mention":
      return `${who} hat dich in ${scene ?? "einer Szene"} erwähnt`;
    case "reply":
      return `${who} hat in ${
        scene ?? "einer Szene"
      } auf einen Kommentar geantwortet`;
    case "share":
      return row.data.collectionName
        ? `${who} hat die Collection „${row.data.collectionName}“ mit dir geteilt`
        : `${who} hat ${scene ?? "eine Szene"} mit dir geteilt`;
    default:
      return `${who} hat etwas geändert`;
  }
};

export const createNotifications = (ctx: AppContext) => {
  const { db, config } = ctx;
  let transport: Transporter | null = null;
  const mailer = () => {
    if (!config.smtp) {
      return null;
    }
    transport ??= createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      ...(config.smtp.user
        ? { auth: { user: config.smtp.user, pass: config.smtp.password || "" } }
        : {}),
    });
    return transport;
  };

  const emailPreferences = async (userIds: string[]) => {
    const rows = userIds.length
      ? await db
          .selectFrom("user_preferences")
          .select(["user_id", "preferences"])
          .where("user_id", "in", userIds)
          .execute()
      : [];
    const byUser = new Map(
      rows.map((row) => [
        row.user_id,
        {
          ...DEFAULT_EMAIL,
          ...((row.preferences as { email?: Partial<EmailPreferences> })
            .email || {}),
        },
      ]),
    );
    return (userId: string) => byUser.get(userId) || DEFAULT_EMAIL;
  };

  /** write notifications; never fails the action that caused them */
  const notify = (input: NotifyInput) => {
    void (async () => {
      const ids = [...new Set(input.userIds)].filter(
        (id) => id !== input.actor.id,
      );
      if (!ids.length) {
        return;
      }
      const users = await db
        .selectFrom("users")
        .select(["id", "email"])
        .where("id", "in", ids)
        .where("disabled_at", "is", null)
        .where("erased_at", "is", null)
        .execute();
      if (!users.length) {
        return;
      }
      const preferences = await emailPreferences(users.map((user) => user.id));
      await db
        .insertInto("notifications")
        .values(
          users.map((user) => ({
            user_id: user.id,
            type: input.type,
            actor_id: input.actor.id,
            scene_id: input.sceneId ?? null,
            collection_id: input.collectionId ?? null,
            thread_id: input.threadId ?? null,
            data: JSON.stringify(input.data || {}),
            email_state:
              config.smtp && user.email && preferences(user.id)[input.type]
                ? ("pending" as const)
                : ("none" as const),
          })),
        )
        .execute();
      ctx.realtime.notifyUsers(users.map((user) => user.id));
    })().catch((error) =>
      ctx.log.error({ err: error, type: input.type }, "notification not saved"),
    );
  };

  /** members of groups (as of their last login), for shares to a group */
  const groupMembers = async (groups: string[]) => {
    if (!groups.length) {
      return [];
    }
    const rows = await db
      .selectFrom("users")
      .select("id")
      .where(sql<boolean>`groups && ${groups}::text[]`)
      .where("disabled_at", "is", null)
      .limit(MAX_GROUP_RECIPIENTS + 1)
      .execute();
    return rows.length > MAX_GROUP_RECIPIENTS ? [] : rows.map((row) => row.id);
  };

  const list = async (userId: string, before?: string) => {
    let query = db
      .selectFrom("notifications as n")
      .leftJoin("users as a", "a.id", "n.actor_id")
      .leftJoin("scenes as s", "s.id", "n.scene_id")
      .select([
        "n.id",
        "n.type",
        "n.scene_id",
        "n.collection_id",
        "n.thread_id",
        "n.data",
        "n.created_at",
        "n.read_at",
        "a.id as actor_id",
        "a.name as actor_name",
        "s.name as scene_name",
        "s.deleted_at as scene_deleted_at",
      ])
      .where("n.user_id", "=", userId);
    if (before) {
      query = query.where("n.id", "<", before);
    }
    const rows = await query.orderBy("n.id", "desc").limit(30).execute();
    const unread = await unreadCount(userId);
    return {
      unread,
      notifications: rows.map((row) => {
        const data = {
          ...(row.data as Record<string, unknown>),
          ...(row.scene_name ? { sceneName: row.scene_name } : {}),
        };
        return {
          id: row.id,
          type: row.type,
          at: row.created_at,
          read: !!row.read_at,
          actor: row.actor_id
            ? { id: row.actor_id, name: row.actor_name }
            : null,
          text: describeNotification({
            type: row.type,
            actor: row.actor_name,
            data,
          }),
          sceneId: row.scene_id,
          collectionId: row.collection_id,
          threadId: row.thread_id,
          available: row.scene_id
            ? !!row.scene_name && !row.scene_deleted_at
            : true,
        };
      }),
      next: rows.length === 30 ? rows[rows.length - 1].id : null,
    };
  };

  const unreadCount = async (userId: string) => {
    const row = await db
      .selectFrom("notifications")
      .select(sql<number>`count(*)::int`.as("count"))
      .where("user_id", "=", userId)
      .where("read_at", "is", null)
      .executeTakeFirstOrThrow();
    return row.count;
  };

  const markRead = async (userId: string, ids: string[] | "all") => {
    let query = db
      .updateTable("notifications")
      .set({
        read_at: sql`now()`,
        // read in the app: no e-mail needed any more
        email_state: sql`case when email_state = 'pending' then 'none' else email_state end`,
      })
      .where("user_id", "=", userId)
      .where("read_at", "is", null);
    if (ids !== "all") {
      if (!ids.length) {
        return;
      }
      query = query.where("id", "in", ids);
    }
    await query.execute();
  };

  const getPreferences = async (userId: string) =>
    (await emailPreferences([userId]))(userId);

  const setPreferences = async (
    userId: string,
    email: Partial<EmailPreferences>,
  ) => {
    const next = { ...(await getPreferences(userId)), ...email };
    const value = JSON.stringify({ email: next });
    await db
      .insertInto("user_preferences")
      .values({ user_id: userId, preferences: value })
      .onConflict((oc) =>
        oc
          .column("user_id")
          .doUpdateSet({ preferences: value, updated_at: sql`now()` }),
      )
      .execute();
    return next;
  };

  /** the job: one e-mail per person with what is still unread */
  const sendEmails = async () => {
    const transporter = mailer();
    if (!transporter || !config.smtp) {
      return 0;
    }
    const due = await db
      .selectFrom("notifications as n")
      .innerJoin("users as u", "u.id", "n.user_id")
      .leftJoin("users as a", "a.id", "n.actor_id")
      .leftJoin("scenes as s", "s.id", "n.scene_id")
      .select([
        "n.id",
        "n.user_id",
        "n.type",
        "n.data",
        "n.scene_id",
        "n.collection_id",
        "n.thread_id",
        "u.email",
        "u.name as user_name",
        "a.name as actor_name",
        "s.name as scene_name",
      ])
      .where("n.email_state", "=", "pending")
      .where(
        "n.created_at",
        "<",
        sql<Date>`now() - make_interval(mins => ${config.notifyEmailDelayMinutes})`,
      )
      .orderBy("n.user_id")
      .orderBy("n.id")
      .limit(500)
      .execute();
    const byUser = new Map<string, typeof due>();
    for (const row of due) {
      byUser.set(row.user_id, [...(byUser.get(row.user_id) || []), row]);
    }
    const branding = await db
      .selectFrom("settings")
      .select("value")
      .where("key", "=", "branding")
      .executeTakeFirst();
    const appName =
      (branding?.value as { name?: string } | undefined)?.name || "Excalidraw";
    const origin = config.publicUrl.origin;
    let sent = 0;
    for (const [userId, rows] of byUser) {
      const lines = rows.map((row) => {
        const data = {
          ...(row.data as Record<string, unknown>),
          ...(row.scene_name ? { sceneName: row.scene_name } : {}),
        };
        const link = row.scene_id
          ? `${origin}/s/${row.scene_id}${
              row.thread_id ? `?thread=${row.thread_id}` : ""
            }`
          : row.collection_id
          ? `${origin}/?c=${row.collection_id}`
          : `${origin}/`;
        return {
          text: describeNotification({
            type: row.type,
            actor: row.actor_name,
            data,
          }),
          link,
        };
      });
      const subject =
        lines.length === 1
          ? `${appName}: ${lines[0].text}`
          : `${appName}: ${lines.length} neue Benachrichtigungen`;
      const settings = `${origin}/?notifications=settings`;
      let state: "sent" | "failed" = "sent";
      try {
        await transporter.sendMail({
          from: config.smtp.from,
          to: rows[0].email!,
          subject,
          text: [
            `Hallo ${rows[0].user_name},`,
            "",
            ...lines.map((line) => `- ${line.text}\n  ${line.link}`),
            "",
            `Welche Benachrichtigungen per E-Mail kommen, stellst du hier ein: ${settings}`,
          ].join("\n"),
          html: `<p>Hallo ${escapeHtml(rows[0].user_name)},</p><ul>${lines
            .map(
              (line) =>
                `<li><a href="${escapeHtml(line.link)}">${escapeHtml(
                  line.text,
                )}</a></li>`,
            )
            .join(
              "",
            )}</ul><p style="color:#666">Welche Benachrichtigungen per E-Mail kommen, stellst du <a href="${escapeHtml(
            settings,
          )}">hier</a> ein.</p>`,
        });
        sent++;
      } catch (error) {
        state = "failed";
        ctx.log.warn({ err: error, userId }, "notification e-mail not sent");
      }
      await db
        .updateTable("notifications")
        .set({ email_state: state })
        .where(
          "id",
          "in",
          rows.map((row) => row.id),
        )
        .where("email_state", "=", "pending")
        .execute();
    }
    return sent;
  };

  return {
    notify,
    groupMembers,
    list,
    unreadCount,
    markRead,
    getPreferences,
    setPreferences,
    sendEmails,
    emailEnabled: !!config.smtp,
  };
};

export type Notifications = ReturnType<typeof createNotifications>;
