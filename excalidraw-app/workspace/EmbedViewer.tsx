/**
 * Intranet fork: a scene embedded in a wiki or intranet page (T3), at
 * /embed/<token>. Read-only, follows changes (polling), with a link into
 * the app for people who are logged in. Without a login cookie (the page
 * runs in a frame of another site, or nobody logged in yet) it offers the
 * login in a popup, unless the workspace allows embeds without login.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  restoreElements,
} from "@excalidraw/excalidraw";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import { decryptData } from "@excalidraw/excalidraw/data/encryption";
import { MIME_TYPES } from "@excalidraw/common";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { fromBase64 } from "../intranet/api";

import "../index.scss";

import "./workspace.scss";

const POLL_MS = 15 * 1000;
const LOGIN_POLL_MS = 2000;

interface EmbedContent {
  scene: { name: string; revision: number; url: string | null };
  key: string;
  iv: string | null;
  ciphertext: string | null;
}

type State =
  | { status: "loading" }
  | { status: "login"; waiting: boolean }
  | { status: "error"; message: string }
  | {
      status: "ready";
      content: EmbedContent;
      elements: ExcalidrawElement[];
      files: BinaryFileData[];
    };

const decryptContent = async (content: EmbedContent) => {
  if (!content.iv || !content.ciphertext) {
    return [];
  }
  const decrypted = await decryptData(
    fromBase64(content.iv),
    fromBase64(content.ciphertext),
    content.key,
  );
  return JSON.parse(
    new TextDecoder().decode(new Uint8Array(decrypted)),
  ) as ExcalidrawElement[];
};

const loadFiles = async (
  token: string,
  key: string,
  elements: readonly ExcalidrawElement[],
  known: Set<string>,
) => {
  const ids = [
    ...new Set(
      elements
        .filter(
          (element) =>
            element.type === "image" &&
            !element.isDeleted &&
            element.fileId &&
            !known.has(element.fileId),
        )
        .map((element) => (element as { fileId: FileId }).fileId),
    ),
  ];
  const files: BinaryFileData[] = [];
  await Promise.all(
    ids.map(async (id) => {
      try {
        const response = await fetch(
          `/api/embed/${encodeURIComponent(token)}/files/${encodeURIComponent(
            id,
          )}`,
          { credentials: "same-origin" },
        );
        if (!response.ok) {
          return;
        }
        const { data, metadata } = await decompressData<BinaryFileMetadata>(
          new Uint8Array(await response.arrayBuffer()),
          { decryptionKey: key },
        );
        known.add(id);
        files.push({
          id,
          mimeType: metadata.mimeType || MIME_TYPES.binary,
          dataURL: new TextDecoder().decode(data) as DataURL,
          created: metadata.created || Date.now(),
        });
      } catch {
        // a missing image shows as a placeholder
      }
    }),
  );
  return files;
};

export const EmbedViewer = ({ token }: { token: string }) => {
  const [state, setState] = useState<State>({ status: "loading" });
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const revision = useRef<number | null>(null);
  const knownFiles = useRef(new Set<string>());

  /** fetch the scene; null means "not changed since the last time" */
  const fetchContent = useCallback(
    async (since: number | null) => {
      const response = await fetch(
        `/api/embed/${encodeURIComponent(token)}${
          since !== null ? `?since=${since}` : ""
        }`,
        { credentials: "same-origin" },
      );
      if (response.status === 204) {
        return null;
      }
      if (response.status === 401) {
        throw Object.assign(new Error("login"), { login: true });
      }
      if (!response.ok) {
        let message = "Diese Einbettung gibt es nicht mehr.";
        try {
          message = (await response.json()).message || message;
        } catch {
          // keep the generic text
        }
        throw Object.assign(new Error(message), { status: response.status });
      }
      return (await response.json()) as EmbedContent;
    },
    [token],
  );

  const load = useCallback(async () => {
    try {
      const content = await fetchContent(null);
      if (!content) {
        return;
      }
      const elements = await decryptContent(content);
      const files = await loadFiles(
        token,
        content.key,
        elements,
        knownFiles.current,
      );
      revision.current = content.scene.revision;
      document.title = content.scene.name;
      setState({ status: "ready", content, elements, files });
    } catch (error: any) {
      setState(
        error.login
          ? { status: "login", waiting: false }
          : { status: "error", message: error.message },
      );
    }
  }, [fetchContent, token]);

  useEffect(() => {
    load();
  }, [load]);

  // follow changes
  useEffect(() => {
    if (state.status !== "ready" || !api) {
      return;
    }
    const key = state.content.key;
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      try {
        const content = await fetchContent(revision.current);
        if (!content) {
          return;
        }
        const elements = await decryptContent(content);
        const files = await loadFiles(token, key, elements, knownFiles.current);
        revision.current = content.scene.revision;
        if (files.length) {
          api.addFiles(files);
        }
        api.updateScene({
          elements: restoreElements(elements, null),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      } catch (error: any) {
        // the link was switched off or login is needed again: the scene
        // disappears at once, as the share dialog promises
        if (error.login || error.status === 404 || error.status === 403) {
          revision.current = null;
          knownFiles.current.clear();
          setState(
            error.login
              ? { status: "login", waiting: false }
              : { status: "error", message: error.message },
          );
        }
        // anything else: try again with the next round
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [state, api, fetchContent, token]);

  // logging in happens in a popup; this frame checks until it worked
  useEffect(() => {
    if (state.status !== "login" || !state.waiting) {
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(async () => {
      if (Date.now() - started > 3 * 60 * 1000) {
        window.clearInterval(timer);
        setState({ status: "login", waiting: false });
        return;
      }
      try {
        if (await fetchContent(null)) {
          window.clearInterval(timer);
          load();
        }
      } catch {
        // still not logged in
      }
    }, LOGIN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [state, fetchContent, load]);

  if (state.status === "loading") {
    return <div className="ws-theme ws-embed__message">Lade …</div>;
  }
  if (state.status === "error") {
    return <div className="ws-theme ws-embed__message">{state.message}</div>;
  }
  if (state.status === "login") {
    return (
      <div className="ws-theme ws-embed__message">
        <p>Diese Zeichnung sehen nur angemeldete Mitarbeitende.</p>
        <button
          type="button"
          className="ws-button ws-button--primary"
          onClick={() => {
            window.open(
              "/api/auth/login?returnTo=%2Fembed-login",
              "excalidraw-login",
              "popup,width=520,height=680",
            );
            setState({ status: "login", waiting: true });
          }}
        >
          Anmelden
        </button>
        {state.waiting && (
          <p className="ws-muted">
            Nach der Anmeldung im neuen Fenster erscheint die Zeichnung hier.
            Liegt diese Seite in einer anderen Domain, lässt der Browser die
            Anmeldung hier nicht zu; dann bitte „In Excalidraw öffnen“ nutzen
            oder die Einbettung ohne Anmeldung freischalten lassen.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="ws-embed">
      <Excalidraw
        onExcalidrawAPI={setApi}
        initialData={{
          elements: restoreElements(state.elements, null),
          files: Object.fromEntries(state.files.map((file) => [file.id, file])),
          scrollToContent: true,
        }}
        viewModeEnabled
        zenModeEnabled
        UIOptions={{
          canvasActions: {
            changeViewBackgroundColor: false,
            clearCanvas: false,
            export: false,
            loadScene: false,
            saveAsImage: false,
            saveToActiveFile: false,
            toggleTheme: false,
          },
        }}
      >
        <MainMenu>{null}</MainMenu>
      </Excalidraw>
      {state.content.scene.url && (
        <a
          className="ws-theme ws-embed__open"
          href={state.content.scene.url}
          target="_blank"
          rel="noopener"
        >
          In Excalidraw öffnen
        </a>
      )}
    </div>
  );
};

/** the end of the login popup started from an embedded scene */
export const EmbedLoginDone = () => {
  useEffect(() => {
    window.setTimeout(() => window.close(), 800);
  }, []);
  return (
    <div className="ws-theme ws-embed__message">
      <p>Angemeldet. Dieses Fenster schließt sich gleich.</p>
    </div>
  );
};
