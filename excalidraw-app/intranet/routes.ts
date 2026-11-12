/**
 * Intranet fork: the app's pages.
 *
 *   /            dashboard (with "#room=" or "#json=" links: editor, as upstream)
 *   /local       editor with a drawing stored only in this browser
 *   /s/<id>      editor with a workspace scene
 *   /v/<token>   read-only link, resolved to /s/<id>
 *   /admin       administration (app and workspace admins)
 *   /embed/<t>   scene embedded in an intranet page (T3), read-only
 */

export type AppRoute =
  | { kind: "dashboard" }
  | { kind: "local" }
  | { kind: "scene"; sceneId: string }
  | { kind: "readLink"; token: string }
  | { kind: "admin" }
  | { kind: "embed"; token: string }
  | { kind: "embedLogin" };

export const LOCAL_EDITOR_PATH = "/local";
export const ADMIN_PATH = "/admin";

export const scenePath = (sceneId: string) =>
  `/s/${encodeURIComponent(sceneId)}`;

export const getRoute = (location: Location = window.location): AppRoute => {
  const path = location.pathname.replace(/\/+$/, "") || "/";

  const scene = path.match(/^\/s\/([a-zA-Z0-9_-]{8,64})$/);
  if (scene) {
    return { kind: "scene", sceneId: scene[1] };
  }
  const readLink = path.match(/^\/v\/([a-zA-Z0-9_-]{16,64})$/);
  if (readLink) {
    return { kind: "readLink", token: readLink[1] };
  }
  if (path === LOCAL_EDITOR_PATH) {
    return { kind: "local" };
  }
  if (path === ADMIN_PATH) {
    return { kind: "admin" };
  }
  const embed = path.match(/^\/embed\/([a-zA-Z0-9_-]{16,64})$/);
  if (embed) {
    return { kind: "embed", token: embed[1] };
  }
  if (path === "/embed-login") {
    return { kind: "embedLogin" };
  }
  // upstream links (live sessions, share links, library installs) open the
  // editor at the root path
  if (path === "/" && /^#(room|json|url|addLibrary)=/.test(location.hash)) {
    return { kind: "local" };
  }
  if (path === "/" && new URLSearchParams(location.search).has("addLibrary")) {
    return { kind: "local" };
  }
  return { kind: "dashboard" };
};
