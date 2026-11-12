/**
 * AI with the company's own language model (K1) under the admins' control
 * (K2): on or off, who may use it, how often per day. Prompts and answers
 * are passed through, never stored; only the number of requests and tokens
 * per person is kept for today's limit, and sums per day for the figures.
 */
import { sql } from "kysely";

import { createOutputFilter, LlmError, streamChat } from "./llm.js";

import type { LlmMessage } from "./llm.js";
import type { AppContext } from "../context.js";
import type { User } from "../db/schema.js";

export type AiFeature = "text-to-diagram" | "diagram-to-code";

export interface AiSettings {
  enabled: boolean;
  /** requests per person and day (all features together) */
  dailyLimit: number;
  /** Keycloak role needed; null = everyone */
  requiredRole: string | null;
}

export const TEXT_TO_DIAGRAM_PROMPT = `Du erzeugst Diagramme für das Zeichenprogramm Excalidraw.
Antworte ausschließlich mit gültigem Mermaid-Code: ohne Codeblock-Markierungen, ohne Erklärungen, ohne Text davor oder danach.
Bevorzuge flowchart, sequenceDiagram oder classDiagram (andere Diagrammtypen werden nur als Bild eingefügt).
Beschrifte in der Sprache der Anfrage. Setze Beschriftungen mit Sonderzeichen, Klammern oder Umlauten in Anführungszeichen, z. B. A["Antrag prüfen (Team)"].
Wenn eine Folgeanfrage kommt, ändere das vorherige Diagramm und gib es vollständig zurück.`;

export const diagramToCodePrompt = (theme: "light" | "dark") =>
  `Du bist erfahrene Frontend-Entwicklerin. Aus der Skizze im Bild (ein Wireframe) und den Texten daraus entsteht eine einzelne, vollständige HTML-Seite.
Regeln:
- Ein HTML-Dokument mit eingebettetem CSS und nur wenn nötig eingebettetem JavaScript.
- Keine externen Ressourcen: keine CDNs, keine Webfonts, keine Bilder aus dem Netz (Platzhalter mit CSS oder inline-SVG).
- Übernimm Aufbau, Beschriftungen und Reihenfolge der Skizze, gestalte sauber und gut lesbar, ${
    theme === "dark"
      ? "in einem dunklen Farbschema"
      : "in einem hellen Farbschema"
  }.
- Antworte nur mit dem HTML-Dokument, ohne Codeblock-Markierungen und ohne Erklärungen.`;

// first of the two advisory lock keys: "excalidraw AI limit"
const LIMIT_LOCK_NAMESPACE = 72_208;

export class AiRefused extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "AiRefused";
  }
}

export const createAi = (ctx: AppContext) => {
  const { db, config } = ctx;
  const configured = !!(config.ai.baseUrl && config.ai.model);

  const settings = async (): Promise<AiSettings> => {
    const row = await db
      .selectFrom("settings")
      .select("value")
      .where("key", "=", "ai")
      .executeTakeFirst();
    const stored = (row?.value || {}) as Partial<AiSettings>;
    return {
      enabled: stored.enabled ?? true,
      dailyLimit:
        typeof stored.dailyLimit === "number"
          ? stored.dailyLimit
          : config.ai.dailyLimit,
      requiredRole:
        stored.requiredRole !== undefined
          ? stored.requiredRole
          : config.ai.requiredRole,
    };
  };

  const saveSettings = async (value: AiSettings, userId: string) => {
    await db
      .insertInto("settings")
      .values({ key: "ai", value: JSON.stringify(value), updated_by: userId })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          value: JSON.stringify(value),
          updated_by: userId,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  };

  const mayUse = (user: User, current: AiSettings) =>
    configured &&
    current.enabled &&
    (!current.requiredRole ||
      user.is_admin ||
      user.roles.includes(current.requiredRole));

  /** what the app shows: the AI features this person may use */
  const statusFor = async (user: User) => {
    const current = await settings();
    const allowed = mayUse(user, current);
    return {
      enabled: allowed,
      diagramToCode: allowed && !!config.ai.visionModel,
      dailyLimit: current.dailyLimit,
    };
  };

  /**
   * Count a request against the person's daily limit (all features
   * together). Returns the day it counts for and the requests left, or null
   * at the limit. One request of a person at a time: parallel requests must
   * not all pass the check before any of them is counted.
   */
  const take = (userId: string, feature: AiFeature, limit: number) =>
    db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(${LIMIT_LOCK_NAMESPACE}::int, hashtext(${userId}::text))`.execute(
        trx,
      );
      const { rows } = await sql<{ day: string; used: number }>`
        select to_char(current_date, 'YYYY-MM-DD') as day,
               coalesce(sum(requests), 0)::int as used
        from ai_usage
        where user_id = ${userId} and day = current_date
      `.execute(trx);
      const { day, used } = rows[0];
      if (Number(used) >= limit) {
        return null;
      }
      await sql`
        insert into ai_usage (user_id, day, feature, requests)
        values (${userId}, ${day}::date, ${feature}, 1)
        on conflict (user_id, day, feature)
          do update set requests = ai_usage.requests + 1
      `.execute(trx);
      return { day, remaining: Math.max(0, limit - Number(used) - 1) };
    });

  const countTokens = async (
    userId: string,
    feature: AiFeature,
    day: string,
    usage: { prompt_tokens?: number; completion_tokens?: number },
  ) => {
    await sql`
      update ai_usage set
        prompt_tokens = prompt_tokens + ${Math.max(
          0,
          Math.round(usage.prompt_tokens || 0),
        )},
        completion_tokens = completion_tokens + ${Math.max(
          0,
          Math.round(usage.completion_tokens || 0),
        )}
      where user_id = ${userId} and day = ${day}::date and feature = ${feature}
    `.execute(db);
  };

  /** check everything before a request goes to the model */
  const admit = async (user: User, feature: AiFeature) => {
    const current = await settings();
    if (!configured) {
      throw new AiRefused(
        503,
        "Für diese Installation ist keine KI eingerichtet.",
      );
    }
    if (!mayUse(user, current)) {
      throw new AiRefused(
        403,
        current.enabled
          ? "Die KI-Funktionen sind für dich nicht freigeschaltet."
          : "Die KI-Funktionen sind abgeschaltet.",
      );
    }
    if (feature === "diagram-to-code" && !config.ai.visionModel) {
      throw new AiRefused(
        501,
        "Für „Wireframe zu Code“ ist kein Sprachmodell mit Bildverständnis eingerichtet.",
      );
    }
    const taken = await take(user.id, feature, current.dailyLimit);
    if (taken === null) {
      throw new AiRefused(
        429,
        `Dein Tageslimit von ${current.dailyLimit} KI-Anfragen ist erreicht. Morgen geht es weiter.`,
      );
    }
    return {
      limit: current.dailyLimit,
      remaining: taken.remaining,
      day: taken.day,
    };
  };

  /**
   * Run a request: chunks of the filtered answer as they come. The caller
   * streams them to the browser.
   */
  async function* generate(
    user: User,
    feature: AiFeature,
    /** the day the request was counted for (admit) */
    day: string,
    messages: LlmMessage[],
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    const filter = createOutputFilter();
    const model =
      feature === "diagram-to-code" ? config.ai.visionModel! : config.ai.model!;
    const timeout = AbortSignal.timeout(config.ai.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let usage: { prompt_tokens?: number; completion_tokens?: number } | null =
      null;
    try {
      for await (const chunk of streamChat(
        {
          baseUrl: config.ai.baseUrl!,
          apiKey: config.ai.apiKey,
          model,
          maxTokens: config.ai.maxTokens,
          signal: combined,
        },
        messages,
      )) {
        if (chunk.usage) {
          usage = chunk.usage;
        }
        if (chunk.delta) {
          const text = filter.push(chunk.delta);
          if (text) {
            yield text;
          }
        }
      }
      const rest = filter.end();
      if (rest) {
        yield rest;
      }
    } catch (error) {
      if (timeout.aborted && !signal.aborted) {
        throw new LlmError(504, "Das Sprachmodell hat zu lange gebraucht.");
      }
      throw error;
    } finally {
      if (usage) {
        await countTokens(user.id, feature, day, usage).catch((error) =>
          ctx.log.warn({ err: error }, "AI tokens not counted"),
        );
      }
    }
  }

  /** figures for the admins: per day, never per person */
  const usageByDay = async (days = 30) => {
    const { rows } = await sql<{
      day: string;
      requests: number;
      people: number;
      prompt_tokens: string;
      completion_tokens: string;
    }>`
      select to_char(day, 'YYYY-MM-DD') as day,
             sum(requests)::int as requests,
             sum(people)::int as people,
             sum(prompt_tokens)::bigint as prompt_tokens,
             sum(completion_tokens)::bigint as completion_tokens
      from (
        select day, requests, people, prompt_tokens, completion_tokens
        from ai_usage_daily
        union all
        select day, sum(requests)::int, count(distinct user_id)::int,
               sum(prompt_tokens)::bigint, sum(completion_tokens)::bigint
        from ai_usage
        group by day
      ) figures
      where day > current_date - ${days}::int
      group by day
      order by day desc
    `.execute(db);
    return rows.map((row) => ({
      day: row.day,
      requests: Number(row.requests),
      people: Number(row.people),
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
    }));
  };

  /**
   * Per person only today's and yesterday's counts are kept (the limit and
   * requests running over midnight need them); older days become sums.
   */
  const condenseUsage = async () => {
    await sql`
      with moved as (
        delete from ai_usage where day < current_date - 1 returning *
      )
      insert into ai_usage_daily (day, requests, people, prompt_tokens, completion_tokens)
      select day, sum(requests)::int, count(distinct user_id)::int,
             sum(prompt_tokens)::bigint, sum(completion_tokens)::bigint
      from moved
      group by day
      on conflict (day) do update set
        requests = ai_usage_daily.requests + excluded.requests,
        people = ai_usage_daily.people + excluded.people,
        prompt_tokens = ai_usage_daily.prompt_tokens + excluded.prompt_tokens,
        completion_tokens = ai_usage_daily.completion_tokens + excluded.completion_tokens
    `.execute(db);
  };

  return {
    configured,
    settings,
    saveSettings,
    statusFor,
    admit,
    generate,
    usageByDay,
    condenseUsage,
  };
};

export type Ai = ReturnType<typeof createAi>;
