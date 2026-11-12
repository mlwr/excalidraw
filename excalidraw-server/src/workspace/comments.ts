/**
 * Comments on scenes (Z2): threads pinned to a point or an element, with
 * replies, "resolved" state and mentions. Texts are encrypted with the
 * scene's key like the drawing itself.
 *
 * Rights: everyone who can see the scene can read and write comments.
 * Resolving needs edit rights or the thread's author. Comments can be
 * edited by their author and deleted by their author or whoever manages the
 * scene.
 */
import { sql } from "kysely";

import {
  decryptWithSceneKey,
  encryptWithSceneKey,
  openSceneKey,
} from "../util/crypto.js";
import { HttpError } from "../util/http.js";

import { actorOf, atLeast, sceneAccess } from "./access.js";
import { notFound } from "./service.js";

import type { AppContext } from "../context.js";
import type { Comment, CommentThread } from "../db/schema.js";
import type { Actor, SceneAccess } from "./access.js";
import type { WorkspaceService } from "./service.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ELEMENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TEXT_LENGTH = 5000;
const MAX_MENTIONS = 20;
const MAX_COORDINATE = 1e7;

export type ThreadStatus = "open" | "resolved" | "all";

const cleanText = (value: unknown) => {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_text", "Bitte einen Text angeben.");
  }
  const text = value
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (!text) {
    throw new HttpError(400, "invalid_text", "Bitte einen Text angeben.");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new HttpError(
      400,
      "text_too_long",
      `Höchstens ${MAX_TEXT_LENGTH} Zeichen.`,
    );
  }
  return text;
};

const coordinate = (value: unknown, name: string) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > MAX_COORDINATE
  ) {
    throw new HttpError(
      400,
      "invalid_position",
      `${name} fehlt oder ist ungültig.`,
    );
  }
  return value;
};

export const createCommentService = (
  ctx: AppContext,
  workspace: WorkspaceService,
) => {
  const { db, config } = ctx;
  const keyOf = (access: SceneAccess) =>
    openSceneKey(config.dataEncryptionKey, access.scene.key_sealed);

  /** mentioned people: only those who can see the scene */
  const mentionsOf = async (value: unknown, sceneId: string) => {
    if (value === undefined || value === null) {
      return [];
    }
    if (
      !Array.isArray(value) ||
      value.length > MAX_MENTIONS ||
      value.some((id) => typeof id !== "string" || !UUID_RE.test(id))
    ) {
      throw new HttpError(400, "invalid_mentions", "Ungültige Erwähnungen.");
    }
    const ids = [...new Set(value.map((id: string) => id.toLowerCase()))];
    if (!ids.length) {
      return [];
    }
    const found = await db
      .selectFrom("users")
      .selectAll()
      .where("id", "in", ids)
      .where("disabled_at", "is", null)
      .execute();
    const mentioned: string[] = [];
    for (const user of found) {
      const access = await sceneAccess(db, actorOf(user), sceneId);
      if (!access || access.role === "none") {
        throw new HttpError(
          400,
          "mention_without_access",
          `${user.name} hat keinen Zugriff auf diese Szene.`,
        );
      }
      mentioned.push(user.id);
    }
    return mentioned;
  };

  const threadFor = async (actor: Actor, threadId: string) => {
    if (typeof threadId !== "string" || !UUID_RE.test(threadId)) {
      throw notFound("Kommentar");
    }
    const thread = await db
      .selectFrom("comment_threads")
      .selectAll()
      .where("id", "=", threadId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!thread) {
      throw notFound("Kommentar");
    }
    // same answer as for a thread that doesn't exist
    const access = await workspace
      .sceneFor(actor, thread.scene_id, "viewer")
      .catch(() => {
        throw notFound("Kommentar");
      });
    return { thread, access };
  };

  const commentFor = async (actor: Actor, commentId: string) => {
    if (typeof commentId !== "string" || !UUID_RE.test(commentId)) {
      throw notFound("Kommentar");
    }
    const comment = await db
      .selectFrom("comments")
      .selectAll()
      .where("id", "=", commentId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!comment) {
      throw notFound("Kommentar");
    }
    return { comment, ...(await threadFor(actor, comment.thread_id)) };
  };

  const canResolve = (
    actor: Actor,
    thread: CommentThread,
    access: SceneAccess,
  ) => atLeast(access.role, "editor") || thread.created_by === actor.id;

  const describe = async (
    actor: Actor,
    access: SceneAccess,
    threads: CommentThread[],
    comments: Comment[],
  ) => {
    const key = keyOf(access);
    const people = new Set<string>();
    threads.forEach((thread) => {
      thread.created_by && people.add(thread.created_by);
      thread.resolved_by && people.add(thread.resolved_by);
    });
    comments.forEach((comment) => {
      comment.author_id && people.add(comment.author_id);
      comment.mentions.forEach((id) => people.add(id));
    });
    const names = new Map(
      people.size
        ? (
            await db
              .selectFrom("users")
              .select(["id", "name"])
              .where("id", "in", [...people])
              .execute()
          ).map((row) => [row.id, row.name])
        : [],
    );
    const person = (id: string | null) =>
      id ? { id, name: names.get(id) || "Unbekannte Person" } : null;

    return threads
      .map((thread) => ({
        id: thread.id,
        sceneId: thread.scene_id,
        x: thread.x,
        y: thread.y,
        elementId: thread.element_id,
        createdAt: thread.created_at,
        createdBy: person(thread.created_by),
        updatedAt: thread.updated_at,
        resolved: !!thread.resolved_at,
        resolvedAt: thread.resolved_at,
        resolvedBy: person(thread.resolved_by),
        canResolve: canResolve(actor, thread, access),
        comments: comments
          .filter((comment) => comment.thread_id === thread.id)
          .map((comment) => ({
            id: comment.id,
            text: decryptWithSceneKey(key, comment.body).toString("utf8"),
            author: person(comment.author_id),
            mentions: comment.mentions.map((id) => person(id)!),
            createdAt: comment.created_at,
            editedAt: comment.edited_at,
            canEdit: comment.author_id === actor.id,
            canDelete: comment.author_id === actor.id || access.canManage,
          })),
      }))
      .filter((thread) => thread.comments.length > 0);
  };

  const threadsOf = async (
    actor: Actor,
    access: SceneAccess,
    filter: { status?: ThreadStatus; threadId?: string } = {},
  ) => {
    let query = db
      .selectFrom("comment_threads")
      .selectAll()
      .where("scene_id", "=", access.scene.id)
      .where("deleted_at", "is", null);
    if (filter.threadId) {
      query = query.where("id", "=", filter.threadId);
    }
    if (filter.status === "open") {
      query = query.where("resolved_at", "is", null);
    } else if (filter.status === "resolved") {
      query = query.where("resolved_at", "is not", null);
    }
    const threads = await query.orderBy("created_at").limit(1000).execute();
    const comments = threads.length
      ? await db
          .selectFrom("comments")
          .selectAll()
          .where(
            "thread_id",
            "in",
            threads.map((thread) => thread.id),
          )
          .where("deleted_at", "is", null)
          .orderBy("created_at")
          .execute()
      : [];
    return describe(actor, access, threads, comments);
  };

  const list = async (actor: Actor, sceneId: string, status: ThreadStatus) =>
    threadsOf(actor, await workspace.sceneFor(actor, sceneId, "viewer"), {
      status,
    });

  const one = async (actor: Actor, access: SceneAccess, threadId: string) =>
    (await threadsOf(actor, access, { threadId }))[0] || null;

  /** open editors reload the comments; the search index takes them up */
  const changed = (sceneId: string) => {
    ctx.realtime.notifyComments(sceneId);
    ctx.search.markDirty(sceneId);
  };

  /** for the activity feed: who commented where (never the text) */
  const log = (
    type:
      | "comment.created"
      | "comment.replied"
      | "comment.resolved"
      | "comment.reopened"
      | "comment.deleted",
    actor: Actor,
    access: SceneAccess,
    threadId: string,
  ) =>
    ctx.events.record({
      type,
      actor: { id: actor.id, name: actor.name || "" },
      workspaceId: access.scene.workspace_id,
      collectionId: access.scene.collection_id,
      sceneId: access.scene.id,
      target: threadId,
      data: { name: access.scene.name },
    });

  /**
   * Z3: the mentioned hear they were mentioned; on a reply, the others
   * in the thread hear about it (if they still see the scene)
   */
  const tell = (
    actor: Actor,
    access: SceneAccess,
    threadId: string,
    mentions: string[],
    isReply: boolean,
  ) => {
    const base = {
      actor: { id: actor.id, name: actor.name || "" },
      sceneId: access.scene.id,
      threadId,
      data: { sceneName: access.scene.name },
    };
    if (mentions.length) {
      ctx.notifications.notify({ ...base, type: "mention", userIds: mentions });
    }
    if (!isReply) {
      return;
    }
    void (async () => {
      const thread = await db
        .selectFrom("comment_threads")
        .select("created_by")
        .where("id", "=", threadId)
        .executeTakeFirst();
      const authors = await db
        .selectFrom("comments")
        .select("author_id")
        .distinct()
        .where("thread_id", "=", threadId)
        .where("deleted_at", "is", null)
        .execute();
      const candidates = [
        ...new Set(
          [thread?.created_by, ...authors.map((row) => row.author_id)].filter(
            (id): id is string =>
              !!id && id !== actor.id && !mentions.includes(id),
          ),
        ),
      ];
      if (!candidates.length) {
        return;
      }
      const users = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "in", candidates)
        .where("disabled_at", "is", null)
        .execute();
      const still: string[] = [];
      for (const user of users) {
        const seen = await sceneAccess(db, actorOf(user), access.scene.id);
        if (seen && seen.role !== "none") {
          still.push(user.id);
        }
      }
      ctx.notifications.notify({ ...base, type: "reply", userIds: still });
    })().catch((error) =>
      ctx.log.warn({ err: error, threadId }, "reply notifications failed"),
    );
  };

  const createThread = async (
    actor: Actor,
    sceneId: string,
    input: {
      x?: unknown;
      y?: unknown;
      elementId?: unknown;
      text?: unknown;
      mentions?: unknown;
    },
  ) => {
    const access = await workspace.sceneFor(actor, sceneId, "viewer");
    const text = cleanText(input.text);
    const x = coordinate(input.x, "x");
    const y = coordinate(input.y, "y");
    const elementId =
      input.elementId === undefined || input.elementId === null
        ? null
        : typeof input.elementId === "string" &&
          ELEMENT_ID_RE.test(input.elementId)
        ? input.elementId
        : (() => {
            throw new HttpError(400, "invalid_element", "Ungültige elementId.");
          })();
    const mentions = await mentionsOf(input.mentions, access.scene.id);
    const key = keyOf(access);
    const threadId = await db.transaction().execute(async (trx) => {
      const thread = await trx
        .insertInto("comment_threads")
        .values({
          scene_id: access.scene.id,
          x,
          y,
          element_id: elementId,
          created_by: actor.id,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("comments")
        .values({
          thread_id: thread.id,
          author_id: actor.id,
          body: encryptWithSceneKey(key, Buffer.from(text, "utf8")),
          mentions,
        })
        .execute();
      return thread.id;
    });
    changed(access.scene.id);
    log("comment.created", actor, access, threadId);
    tell(actor, access, threadId, mentions, false);
    return one(actor, access, threadId);
  };

  const reply = async (
    actor: Actor,
    threadId: string,
    input: { text?: unknown; mentions?: unknown },
  ) => {
    const { thread, access } = await threadFor(actor, threadId);
    const text = cleanText(input.text);
    const mentions = await mentionsOf(input.mentions, access.scene.id);
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("comments")
        .values({
          thread_id: thread.id,
          author_id: actor.id,
          body: encryptWithSceneKey(keyOf(access), Buffer.from(text, "utf8")),
          mentions,
        })
        .execute();
      // a reply opens a resolved thread again
      await trx
        .updateTable("comment_threads")
        .set({ updated_at: sql`now()`, resolved_at: null, resolved_by: null })
        .where("id", "=", thread.id)
        .execute();
    });
    changed(access.scene.id);
    log("comment.replied", actor, access, thread.id);
    tell(actor, access, thread.id, mentions, true);
    return one(actor, access, thread.id);
  };

  const setResolved = async (
    actor: Actor,
    threadId: string,
    resolved: unknown,
  ) => {
    if (typeof resolved !== "boolean") {
      throw new HttpError(
        400,
        "invalid_body",
        "resolved muss true oder false sein.",
      );
    }
    const { thread, access } = await threadFor(actor, threadId);
    if (!canResolve(actor, thread, access)) {
      throw new HttpError(403, "forbidden", "Dafür fehlen dir die Rechte.");
    }
    await db
      .updateTable("comment_threads")
      .set(
        resolved
          ? { resolved_at: sql`now()`, resolved_by: actor.id }
          : { resolved_at: null, resolved_by: null },
      )
      .where("id", "=", thread.id)
      .execute();
    changed(access.scene.id);
    log(
      resolved ? "comment.resolved" : "comment.reopened",
      actor,
      access,
      thread.id,
    );
    return one(actor, access, thread.id);
  };

  /** move a thread's pin (e.g. dragged in the editor) */
  const move = async (
    actor: Actor,
    threadId: string,
    input: { x?: unknown; y?: unknown; elementId?: unknown },
  ) => {
    const { thread, access } = await threadFor(actor, threadId);
    if (!canResolve(actor, thread, access)) {
      throw new HttpError(403, "forbidden", "Dafür fehlen dir die Rechte.");
    }
    const elementId =
      input.elementId === null || input.elementId === undefined
        ? null
        : typeof input.elementId === "string" &&
          ELEMENT_ID_RE.test(input.elementId)
        ? input.elementId
        : (() => {
            throw new HttpError(400, "invalid_element", "Ungültige elementId.");
          })();
    await db
      .updateTable("comment_threads")
      .set({
        x: coordinate(input.x, "x"),
        y: coordinate(input.y, "y"),
        element_id: elementId,
      })
      .where("id", "=", thread.id)
      .execute();
    changed(access.scene.id);
    return one(actor, access, thread.id);
  };

  const edit = async (
    actor: Actor,
    commentId: string,
    input: { text?: unknown },
  ) => {
    const { comment, access } = await commentFor(actor, commentId);
    if (comment.author_id !== actor.id) {
      throw new HttpError(
        403,
        "forbidden",
        "Nur eigene Kommentare lassen sich bearbeiten.",
      );
    }
    const text = cleanText(input.text);
    await db
      .updateTable("comments")
      .set({
        body: encryptWithSceneKey(keyOf(access), Buffer.from(text, "utf8")),
        edited_at: sql`now()`,
      })
      .where("id", "=", comment.id)
      .execute();
    changed(access.scene.id);
    return one(actor, access, comment.thread_id);
  };

  /** delete a comment; a thread without comments is gone too */
  const remove = async (actor: Actor, commentId: string) => {
    const { comment, thread, access } = await commentFor(actor, commentId);
    if (comment.author_id !== actor.id && !access.canManage) {
      throw new HttpError(403, "forbidden", "Dafür fehlen dir die Rechte.");
    }
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("comments")
        .set({ deleted_at: sql`now()` })
        .where("id", "=", comment.id)
        .execute();
      const left = await trx
        .selectFrom("comments")
        .select(sql<number>`count(*)::int`.as("count"))
        .where("thread_id", "=", thread.id)
        .where("deleted_at", "is", null)
        .executeTakeFirstOrThrow();
      if (left.count === 0) {
        await trx
          .updateTable("comment_threads")
          .set({ deleted_at: sql`now()` })
          .where("id", "=", thread.id)
          .execute();
      }
    });
    changed(access.scene.id);
    log("comment.deleted", actor, access, thread.id);
  };

  /**
   * delete a whole thread: whoever manages the scene, or its author as long
   * as nobody else has answered
   */
  const removeThread = async (actor: Actor, threadId: string) => {
    const { thread, access } = await threadFor(actor, threadId);
    let allowed = access.canManage;
    if (!allowed && thread.created_by === actor.id) {
      const others = await db
        .selectFrom("comments")
        .select("id")
        .where("thread_id", "=", thread.id)
        .where("deleted_at", "is", null)
        .where((eb) =>
          eb.or([eb("author_id", "is", null), eb("author_id", "!=", actor.id)]),
        )
        .executeTakeFirst();
      allowed = !others;
    }
    if (!allowed) {
      throw new HttpError(403, "forbidden", "Dafür fehlen dir die Rechte.");
    }
    await db
      .updateTable("comment_threads")
      .set({ deleted_at: sql`now()` })
      .where("id", "=", thread.id)
      .execute();
    changed(access.scene.id);
  };

  return {
    list,
    createThread,
    reply,
    setResolved,
    move,
    edit,
    remove,
    removeThread,
  };
};

export type CommentService = ReturnType<typeof createCommentService>;
