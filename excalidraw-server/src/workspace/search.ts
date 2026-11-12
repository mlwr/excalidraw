/**
 * Search over all scenes (W6): names, texts in drawings, comments.
 *
 * Drawings and comments are encrypted at rest, so the index holds no words:
 * only keyed hashes (HMAC, key derived from DATA_ENCRYPTION_KEY) of words and
 * of their beginnings (3 to 15 letters, so "Urlaub" finds
 * "Urlaubsantrag"). A database dump reveals no texts; it only shows which
 * scenes share a word. Snippets are taken from the decrypted scene when a
 * search shows it, for people who may see it.
 */
import { createHmac, hkdfSync } from "node:crypto";

import { sql } from "kysely";

import { decryptWithSceneKey, openSceneKey } from "../util/crypto.js";

import { decryptElements } from "./content.js";

import type { AppContext } from "../context.js";
import type { SceneElement } from "../../vendor/elements.mjs";

const WORD_RE = /[\p{L}\p{N}]+/gu;
const MIN_PREFIX = 3;
const MAX_PREFIX = 15;
const MAX_WORD = 30;
const MAX_TOKENS = 20_000;
const BATCH = 25;
/** snippets come from scenes up to this size (encrypted) */
const SNIPPET_MAX_BYTES = 4 * 1024 * 1024;

const normalize = (text: string) => text.normalize("NFKC").toLowerCase();

/** words and word beginnings of a text */
export const tokensOf = (text: string, into = new Set<string>()) => {
  for (const match of normalize(text).matchAll(WORD_RE)) {
    const word = match[0].slice(0, MAX_WORD);
    if (word.length < 2) {
      continue;
    }
    into.add(`w:${word}`);
    for (let n = MIN_PREFIX; n <= Math.min(word.length, MAX_PREFIX); n++) {
      into.add(`p:${word.slice(0, n)}`);
    }
    if (into.size >= MAX_TOKENS) {
      break;
    }
  }
  return into;
};

/** the tokens a query needs (every word must occur, as word or beginning) */
export const queryTokens = (query: string) => {
  const tokens = new Set<string>();
  for (const match of normalize(query).matchAll(WORD_RE)) {
    const word = match[0];
    if (word.length < 2) {
      continue;
    }
    tokens.add(
      word.length < MIN_PREFIX ? `w:${word}` : `p:${word.slice(0, MAX_PREFIX)}`,
    );
  }
  return [...tokens];
};

/** texts of a drawing: text elements (incl. labels), frame names, links */
export const textsOf = (elements: readonly SceneElement[]) => {
  const texts: string[] = [];
  for (const element of elements) {
    if (element.isDeleted) {
      continue;
    }
    if (typeof element.text === "string") {
      texts.push(element.text);
    }
    if (typeof element.name === "string") {
      texts.push(element.name);
    }
    if (typeof element.link === "string") {
      texts.push(element.link);
    }
  }
  return texts;
};

export const createSearch = (ctx: AppContext) => {
  const { db, config } = ctx;
  const indexKey = Buffer.from(
    hkdfSync(
      "sha256",
      config.dataEncryptionKey,
      Buffer.alloc(0),
      "excalidraw-search-index-v1",
      32,
    ),
  );

  /** 64-bit keyed hash of a token, as Postgres bigint text */
  const hash = (token: string) =>
    createHmac("sha256", indexKey)
      .update(token)
      .digest()
      .readBigInt64BE(0)
      .toString();

  /**
   * texts of a scene: drawing and comments, decrypted. maxBytes: give up on
   * larger scenes (snippets while searching must stay cheap).
   */
  const sceneTexts = async (sceneId: string, maxBytes = Infinity) => {
    const scene = await db
      .selectFrom("scenes")
      .select([
        "id",
        "key_sealed",
        "revision",
        sql<number>`coalesce(octet_length(ciphertext), 0)`.as("size"),
      ])
      .where("id", "=", sceneId)
      .executeTakeFirst();
    if (!scene || scene.size > maxBytes) {
      return null;
    }
    const content = await db
      .selectFrom("scenes")
      .select(["iv", "ciphertext"])
      .where("id", "=", sceneId)
      .executeTakeFirst();
    const key = openSceneKey(config.dataEncryptionKey, scene.key_sealed);
    const elements =
      Number(scene.revision) > 0 && content?.iv && content.ciphertext
        ? decryptElements(key, content.iv, content.ciphertext)
        : [];
    const comments = await db
      .selectFrom("comments")
      .innerJoin("comment_threads", "comment_threads.id", "comments.thread_id")
      .select("comments.body")
      .where("comment_threads.scene_id", "=", sceneId)
      .where("comment_threads.deleted_at", "is", null)
      .where("comments.deleted_at", "is", null)
      .execute();
    return {
      revision: scene.revision,
      drawing: textsOf(elements),
      comments: comments.map((comment) =>
        decryptWithSceneKey(key, comment.body).toString("utf8"),
      ),
    };
  };

  const saveIndex = async (
    sceneId: string,
    hashes: string[],
    revision: string | number,
    startedAt: Date,
  ) => {
    // indexed_at = when reading began: comments changed while indexing
    // (dirty_at later) bring the scene back into the queue
    await db
      .insertInto("scene_search")
      .values({
        scene_id: sceneId,
        tokens: hashes,
        indexed_revision: revision,
        indexed_at: startedAt,
      })
      .onConflict((oc) =>
        oc.column("scene_id").doUpdateSet({
          tokens: hashes,
          indexed_revision: revision,
          indexed_at: startedAt,
        }),
      )
      .execute();
  };

  const indexScene = async (sceneId: string) => {
    const { rows } = await sql<{ now: Date }>`select now() as now`.execute(db);
    const startedAt = rows[0].now;
    let texts: Awaited<ReturnType<typeof sceneTexts>>;
    try {
      texts = await sceneTexts(sceneId);
    } catch (error) {
      // unreadable content: keep it out of the queue until it changes
      ctx.log.warn({ err: error, sceneId }, "scene not indexable");
      const scene = await db
        .selectFrom("scenes")
        .select("revision")
        .where("id", "=", sceneId)
        .executeTakeFirst();
      if (scene) {
        await saveIndex(sceneId, [], scene.revision, startedAt);
      }
      return;
    }
    if (!texts) {
      return;
    }
    const tokens = new Set<string>();
    [...texts.drawing, ...texts.comments].forEach((text) =>
      tokensOf(text, tokens),
    );
    await saveIndex(sceneId, [...tokens].map(hash), texts.revision, startedAt);
  };

  /** the job: index scenes whose content or comments changed */
  const indexPending = async () => {
    if (!config.search.content) {
      return 0;
    }
    const pending = await sql<{ id: string }>`
      select s.id from scenes s
      left join scene_search i on i.scene_id = s.id
      where s.deleted_at is null
        and (i.scene_id is null
             or i.indexed_revision < s.revision
             or i.dirty_at > i.indexed_at)
      order by s.updated_at desc
      limit ${BATCH}
    `.execute(db);
    for (const { id } of pending.rows) {
      await indexScene(id);
    }
    return pending.rows.length;
  };

  /** comments changed: index the scene again */
  const markDirty = (sceneId: string) => {
    void db
      .updateTable("scene_search")
      .set({ dirty_at: sql`now()` })
      .where("scene_id", "=", sceneId)
      .execute()
      .catch(() => {});
  };

  /** hashes for a query, null if it has no usable word */
  const queryHashes = (query: string) => {
    const tokens = queryTokens(query);
    return tokens.length ? tokens.map(hash) : null;
  };

  /** where the query occurs in a scene, for the result list */
  const snippetOf = async (sceneId: string, query: string) => {
    const words = [...normalize(query).matchAll(WORD_RE)]
      .map((match) => match[0])
      .filter((word) => word.length >= 2);
    if (!words.length) {
      return null;
    }
    // unreadable or very large scenes get no snippet
    const texts = await sceneTexts(sceneId, SNIPPET_MAX_BYTES).catch(
      () => null,
    );
    if (!texts) {
      return null;
    }
    const find = (candidates: string[], kind: "drawing" | "comment") => {
      for (const text of candidates) {
        const flat = text.replace(/\s+/g, " ");
        const lower = normalize(flat);
        const at = Math.min(
          ...words.map((word) => lower.indexOf(word)).filter((i) => i >= 0),
        );
        if (Number.isFinite(at)) {
          const start = Math.max(0, at - 40);
          const end = Math.min(flat.length, at + 80);
          return {
            kind,
            text: `${start > 0 ? "…" : ""}${flat.slice(start, end)}${
              end < flat.length ? "…" : ""
            }`,
          };
        }
      }
      return null;
    };
    return find(texts.drawing, "drawing") || find(texts.comments, "comment");
  };

  return { indexScene, indexPending, markDirty, queryHashes, snippetOf };
};

export type Search = ReturnType<typeof createSearch>;
