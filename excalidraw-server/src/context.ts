import type { OidcClient } from "./auth/oidc.js";
import type { AuthContext, SessionStore } from "./auth/sessions.js";
import type { Config } from "./config.js";
import type { Database } from "./db/schema.js";
import type { BlobStore } from "./storage/index.js";
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
}

export interface AppContext {
  config: Config;
  db: Kysely<Database>;
  sessions: SessionStore;
  oidc: OidcClient;
  blobs: BlobStore;
  realtime: RealtimeHooks;
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
  libraries: { browseUrl: config.libraryBrowseUrl },
  workspace: { enabled: true },
});

export type ClientConfig = ReturnType<typeof clientConfig>;
