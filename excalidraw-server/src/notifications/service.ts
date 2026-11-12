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

import { actorOf, collectionRole, sceneAccess } from "../workspace/access.js";

import type { AppContext } from "../context.js";
import type { User } from "../db/schema.js";
import type { Actor } from "../workspace/access.js";
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

/** e-mails the relay did not take are tried again for this long */
export const EMAIL_RETRY_HOURS = 24;

const PAGE = 30;

/** whether the relay refused the message itself (5xx), not just now */
const refusedForGood = (error: unknown) => {
  const code = (error as { responseCode?: unknown })?.responseCode;
  return typeof code === "number" && code >= 500;
};

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
      pool: true,
      maxConnections: 2,
      // a relay that does not answer must not hold up the job
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
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

  /**
   * What someone may still learn about the scenes and collections their
   * notifications point to: current names and whether they can be opened
   * only with access; without, only what the notification said back then.
   */
  const accessFor = (actor: Actor) => {
    const scenes = new Map<string, Promise<string | null>>();
    const collections = new Map<string, Promise<string | null>>();
    const remember = (
      cache: Map<string, Promise<string | null>>,
      id: string,
      load: () => Promise<string | null>,
    ) => {
      let result = cache.get(id);
      if (!result) {
        result = load();
        cache.set(id, result);
      }
      return result;
    };
    return {
      /** the scene's current name, null without access */
      scene: (sceneId: string) =>
        remember(scenes, sceneId, async () => {
          const access = await sceneAccess(db, actor, sceneId);
          return access && access.role !== "none" ? access.scene.name : null;
        }),
      /** the collection's current name, null without access */
      collection: (collectionId: string) =>
        remember(collections, collectionId, async () => {
          const collection = await db
            .selectFrom("collections")
            .selectAll()
            .where("id", "=", collectionId)
            .executeTakeFirst();
          return collection &&
            (await collectionRole(db, actor, collection)) !== "none"
            ? collection.name
            : null;
        }),
    };
  };

  /** live names (or null) of what a notification points to */
  const lookUp = async (
    access: ReturnType<typeof accessFor>,
    row: { scene_id: string | null; collection_id: string | null },
  ) => {
    if (row.scene_id) {
      const sceneName = await access.scene(row.scene_id);
      return { available: sceneName !== null, live: { sceneName } };
    }
    if (row.collection_id) {
      const collectionName = await access.collection(row.collection_id);
      return {
        available: collectionName !== null,
        live: { collectionName },
      };
    }
    return { available: true, live: {} };
  };

  const withLiveNames = (
    stored: unknown,
    live: { sceneName?: string | null; collectionName?: string | null },
  ) => ({
    ...(stored as Record<string, unknown>),
    ...(live.sceneName ? { sceneName: live.sceneName } : {}),
    ...(live.collectionName ? { collectionName: live.collectionName } : {}),
  });

  const list = async (user: User, before?: string) => {
    let query = db
      .selectFrom("notifications as n")
      .leftJoin("users as a", "a.id", "n.actor_id")
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
      ])
      .where("n.user_id", "=", user.id);
    if (before) {
      query = query.where("n.id", "<", before);
    }
    const rows = await query.orderBy("n.id", "desc").limit(PAGE).execute();
    const unread = await unreadCount(user.id);
    const access = accessFor(actorOf(user));
    const notifications = [];
    for (const row of rows) {
      const { available, live } = await lookUp(access, row);
      notifications.push({
        id: row.id,
        type: row.type,
        at: row.created_at,
        read: !!row.read_at,
        actor: row.actor_id ? { id: row.actor_id, name: row.actor_name } : null,
        text: describeNotification({
          type: row.type,
          actor: row.actor_name,
          data: withLiveNames(row.data, live),
        }),
        sceneId: row.scene_id,
        collectionId: row.collection_id,
        threadId: row.thread_id,
        available,
      });
    }
    return {
      unread,
      notifications,
      next: rows.length === PAGE ? rows[rows.length - 1].id : null,
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

  const setEmailState = async (
    ids: string[],
    state: "none" | "sent" | "failed",
  ) => {
    if (ids.length) {
      await db
        .updateTable("notifications")
        .set({ email_state: state })
        .where("id", "in", ids)
        .where("email_state", "=", "pending")
        .execute();
    }
  };

  /**
   * The job: one e-mail per person with what is still unread. Checked again
   * at sending time: the person is active, still wants these e-mails and
   * still has access to what they are about.
   */
  const sendEmails = async () => {
    const transporter = mailer();
    if (!transporter || !config.smtp) {
      return 0;
    }
    // nobody to write to any more
    await sql`
      update notifications n set email_state = 'none'
      from users u
      where u.id = n.user_id and n.email_state = 'pending'
        and (u.disabled_at is not null or u.erased_at is not null
             or coalesce(u.email, '') = '')
    `.execute(db);
    // the relay did not take them for too long
    await db
      .updateTable("notifications")
      .set({ email_state: "failed" })
      .where("email_state", "=", "pending")
      .where(
        "created_at",
        "<",
        sql<Date>`now() - make_interval(hours => ${EMAIL_RETRY_HOURS})`,
      )
      .execute();
    const due = await db
      .selectFrom("notifications as n")
      .innerJoin("users as u", "u.id", "n.user_id")
      .leftJoin("users as a", "a.id", "n.actor_id")
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
        "u.groups as user_groups",
        "u.is_admin as user_is_admin",
        "a.name as actor_name",
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
    const preferences = await emailPreferences([...byUser.keys()]);
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
      const person = rows[0];
      const access = accessFor({
        id: userId,
        groups: person.user_groups,
        isAdmin: person.user_is_admin,
      });
      const wanted = preferences(userId);
      const dropped: string[] = [];
      const lines: { id: string; text: string; link: string }[] = [];
      for (const row of rows) {
        const { available, live } = wanted[row.type as NotificationType]
          ? await lookUp(access, row)
          : { available: false, live: {} };
        if (!available) {
          dropped.push(row.id);
          continue;
        }
        const link = row.scene_id
          ? `${origin}/s/${row.scene_id}${
              row.thread_id ? `?thread=${row.thread_id}` : ""
            }`
          : row.collection_id
          ? `${origin}/?c=${row.collection_id}`
          : `${origin}/`;
        lines.push({
          id: row.id,
          text: describeNotification({
            type: row.type,
            actor: row.actor_name,
            data: withLiveNames(row.data, live),
          }),
          link,
        });
      }
      await setEmailState(dropped, "none");
      if (!lines.length) {
        continue;
      }
      const subject =
        lines.length === 1
          ? `${appName}: ${lines[0].text}`
          : `${appName}: ${lines.length} neue Benachrichtigungen`;
      const settings = `${origin}/?notifications=settings`;
      try {
        await transporter.sendMail({
          from: config.smtp.from,
          to: person.email!,
          subject,
          text: [
            `Hallo ${person.user_name},`,
            "",
            ...lines.map((line) => `- ${line.text}\n  ${line.link}`),
            "",
            `Welche Benachrichtigungen per E-Mail kommen, stellst du hier ein: ${settings}`,
          ].join("\n"),
          html: `<p>Hallo ${escapeHtml(person.user_name)},</p><ul>${lines
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
        await setEmailState(
          lines.map((line) => line.id),
          "sent",
        );
      } catch (error) {
        if (refusedForGood(error)) {
          ctx.log.warn({ err: error, userId }, "notification e-mail refused");
          await setEmailState(
            lines.map((line) => line.id),
            "failed",
          );
          continue;
        }
        // the relay is away: everything stays pending for the next run
        ctx.log.warn({ err: error }, "mail relay not reachable");
        break;
      }
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
    /** let go of the relay's connections */
    close: () => {
      transport?.close();
      transport = null;
    },
  };
};

export type Notifications = ReturnType<typeof createNotifications>;
