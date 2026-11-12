import type { FastifyBaseLogger } from "fastify";
import type { OidcClient } from "./auth/oidc.js";
import type { AuthContext, SessionStore } from "./auth/sessions.js";
import type { Config } from "./config.js";
import type { Database } from "./db/schema.js";
import type { BlobStore } from "./storage/index.js";
import type { EventLog } from "./events.js";
import type { Lifecycle } from "./workspace/lifecycle.js";
import type { Search } from "./workspace/search.js";
import type { Ai } from "./ai/service.js";
import type { Notifications } from "./notifications/service.js";
import type { EditorSettings } from "./editor/settings.js";
import type { CompanyFonts } from "./editor/fonts.js";
import type { Kysely } from "kysely";

export interface RealtimeHooks {
  /** disconnect all sockets that belong to the given (deleted) sessions */
  disconnectSessions: (sessionIds: string[]) => void;
  /** who is connected to which workspace scene right now */
  scenePresence: () => Promise<Map<string, { id: string; name: string }[]>>;
  /** disconnect everybody from a scene (e.g. after it was deleted) */
  closeSceneRoom: (sceneId: string) => void;
  /**
   * re-check the rights of everyone connected to these scenes (after
   * sharing changes); whoever lost access or changed between viewer and
   * editor is disconnected and reloads the scene
   */
  recheckScenes: (sceneIds: string[]) => Promise<void>;
  /**
   * show elements changed on the server (REST API, MCP) in every editor that
   * has the scene open, like a collaborator's change
   */
  broadcastSceneUpdate: (
    sceneId: string,
    sceneKey: string,
    elements: readonly unknown[],
  ) => void;
  /** tell open editors that the scene's comments changed */
  notifyComments: (sceneId: string) => void;
  /** tell these people's open editors that they have new notifications */
  notifyUsers: (userIds: string[]) => void;
}

export interface AppContext {
  /** for background work that has no request to log through */
  log: FastifyBaseLogger;
  config: Config;
  db: Kysely<Database>;
  sessions: SessionStore;
  oidc: OidcClient;
  blobs: BlobStore;
  realtime: RealtimeHooks;
  /** activity feed and audit log */
  events: EventLog;
  /** versions, trash, deletion periods */
  lifecycle: Lifecycle;
  /** search index */
  search: Search;
  /** AI with the company's language model */
  ai: Ai;
  /** what the editor may embed (E2) */
  editor: EditorSettings;
  /** the company's fonts (E3) */
  fonts: CompanyFonts;
  /** in the app and by e-mail */
  notifications: Notifications;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/** the subset of the server configuration the browser app needs at runtime */
export const clientConfig = (config: Config) => ({
  maxFileSizeBytes: config.limits.maxFileBytes,
  maxImageDimension: config.limits.maxImageDimension,
  ai: { enabled: false },
  embeds: { allowedHosts: [] as string[], external: false },
  fonts: [] as { id: number; family: string; url: string }[],
  libraries: { browseUrl: config.libraryBrowseUrl },
  workspace: { enabled: true },
  api: {
    enabled: config.api.enabled,
    mcpEnabled: config.api.mcpEnabled,
  },
});

export type ClientConfig = ReturnType<typeof clientConfig>;
