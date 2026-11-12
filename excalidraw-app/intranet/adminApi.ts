/**
 * Intranet fork: client for the administration API (/api/admin/*).
 */
import { BackendError, backendFetch } from "./api";

import type { Branding } from "./branding";
import type { PrincipalType, WorkspacePolicies } from "./workspaceApi";

export interface AdminWorkspace {
  id: string;
  slug: string;
  name: string;
  openToAll: boolean;
  isDefault: boolean;
  policies: WorkspacePolicies;
  scenes: number;
  members: number;
  createdAt: string;
}

export type MemberRole = "member" | "admin";

export interface WorkspaceMember {
  type: PrincipalType;
  principal: string;
  role: MemberRole;
  label: string;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string | null;
  username: string | null;
  groups: string[];
  isAdmin: boolean;
  lastLoginAt: string | null;
  disabledAt: string | null;
  erasedAt: string | null;
  activeTokens: number;
}

export interface AuditEvent {
  id: string;
  at: string;
  type: string;
  actor_id: string | null;
  actor_name: string | null;
  workspace_id: string | null;
  collection_id: string | null;
  scene_id: string | null;
  target: string | null;
  data: Record<string, unknown>;
  ip: string | null;
  user_agent: string | null;
}

export interface AuditFilter {
  type?: string;
  actor?: string;
  scene?: string;
  /** ISO dates, "to" exclusive */
  from?: string;
  to?: string;
}

const json = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    let message = `Fehler ${response.status}`;
    try {
      const body = await response.json();
      message = body.message || message;
    } catch {
      // keep the generic message
    }
    throw new BackendError(response.status, message);
  }
  return (response.status === 204 ? undefined : response.json()) as T;
};

const send = (method: string, path: string, body?: unknown) =>
  backendFetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const auditParams = (filter: AuditFilter) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value) {
      params.set(key, value);
    }
  }
  return params;
};

export const adminApi = {
  workspaces: async () =>
    json<{ workspaces: AdminWorkspace[]; isAppAdmin: boolean }>(
      await backendFetch("/api/admin/workspaces"),
    ),

  createWorkspace: async (input: {
    name: string;
    slug?: string;
    openToAll?: boolean;
  }) =>
    json<{ workspace: AdminWorkspace }>(
      await send("POST", "/api/admin/workspaces", input),
    ),

  updateWorkspace: async (
    id: string,
    changes: {
      name?: string;
      openToAll?: boolean;
      policies?: Partial<WorkspacePolicies>;
    },
  ) =>
    json<{ workspace: AdminWorkspace }>(
      await send("PATCH", `/api/admin/workspaces/${id}`, changes),
    ),

  deleteWorkspace: async (id: string) =>
    json<void>(await send("DELETE", `/api/admin/workspaces/${id}`)),

  members: async (id: string) =>
    json<{ members: WorkspaceMember[] }>(
      await backendFetch(`/api/admin/workspaces/${id}/members`),
    ),

  setMembers: async (id: string, members: Omit<WorkspaceMember, "label">[]) =>
    json<{ ok: true }>(
      await send("PUT", `/api/admin/workspaces/${id}/members`, { members }),
    ),

  users: async (q: string, offset = 0) =>
    json<{ users: AdminUser[]; next: number | null }>(
      await backendFetch(
        `/api/admin/users?q=${encodeURIComponent(q)}&offset=${offset}`,
      ),
    ),

  disableUser: async (id: string) =>
    json<{ ok: true }>(await send("POST", `/api/admin/users/${id}/disable`)),

  enableUser: async (id: string) =>
    json<{ ok: true }>(await send("POST", `/api/admin/users/${id}/enable`)),

  revokeTokens: async (id: string) =>
    json<{ revoked: number }>(
      await send("POST", `/api/admin/users/${id}/revoke-tokens`),
    ),

  eraseUser: async (id: string, successorId: string | null) =>
    json<{ moved: number; trashed: number }>(
      await send("POST", `/api/admin/users/${id}/erase`, { successorId }),
    ),

  audit: async (filter: AuditFilter, before?: string) => {
    const params = auditParams(filter);
    if (before) {
      params.set("before", before);
    }
    return json<{ events: AuditEvent[]; next: string | null }>(
      await backendFetch(`/api/admin/audit?${params}`),
    );
  },

  auditCsvUrl: (filter: AuditFilter) => {
    const params = auditParams(filter);
    params.set("format", "csv");
    return `/api/admin/audit?${params}`;
  },

  saveBranding: async (
    changes: Partial<Pick<Branding, "name" | "primaryColor" | "links">>,
  ) => json<Branding>(await send("PUT", "/api/admin/branding", changes)),

  uploadLogo: async (file: File) =>
    json<Branding>(
      await backendFetch("/api/admin/branding/logo", {
        method: "PUT",
        headers: { "content-type": file.type },
        body: file,
      }),
    ),

  removeLogo: async () =>
    json<Branding>(await send("DELETE", "/api/admin/branding/logo")),

  stats: async () =>
    json<Record<string, unknown>>(await backendFetch("/api/admin/stats")),
};
