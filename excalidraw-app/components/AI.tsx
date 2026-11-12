import {
  DiagramToCodePlugin,
  exportScene,
  getNonDeletedElements,
  getTextFromElements,
  parseSSEStream,
  TTDDialog,
  TTDStreamFetch,
  THEME,
  useOnExcalidrawStateChange,
} from "@excalidraw/excalidraw";
import { getDataURL } from "@excalidraw/excalidraw/data/blob";
import { safelyParseJSON } from "@excalidraw/common";

import type { StreamChunk } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { cacheMermaidChunks } from "../data/cacheMermaidChunks";
import { TTDIndexedDBAdapter } from "../data/TTDStorage";

export const AIComponents = ({
  excalidrawAPI,
  diagramToCode = true,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  /** a model that reads images is available */
  diagramToCode?: boolean;
}) => {
  useOnExcalidrawStateChange(
    (appState) => appState.openDialog?.name === "ttd",
    (isTTDDialogOpen) => {
      if (isTTDDialogOpen) {
        cacheMermaidChunks();
      }
    },
  );

  return (
    <>
      <DiagramToCodePlugin
        generate={async ({ frame, children, onPartial }) => {
          if (!diagramToCode) {
            throw new Error(
              "Für „Wireframe zu Code“ ist kein Sprachmodell mit Bildverständnis eingerichtet.",
            );
          }
          const appState = excalidrawAPI.getAppState();

          // SAFETY: This should never happen, but log it just in case
          if (children.some((el) => el.isDeleted)) {
            console.error(
              "[NONDELETED][INVARIANT] Generated children elements should not be `isDeleted: true`",
            );
          }

          const blob = await exportScene({
            type: "jpeg",
            data: {
              elements: getNonDeletedElements(children),
              appState,
              files: excalidrawAPI.getFiles(),
            },
            config: {
              exportingFrame: frame,
              theme: appState.exportWithDarkMode ? THEME.DARK : THEME.LIGHT,
            },
          });

          const dataURL = await getDataURL(blob);

          const textFromFrameChildren = getTextFromElements(children);

          // intranet fork: the company's language model, via our server
          const response = await fetch(
            "/api/ai/diagram-to-code/generate-streaming",
            {
              method: "POST",
              headers: {
                Accept: "text/event-stream",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                texts: textFromFrameChildren,
                image: dataURL,
                theme: appState.theme,
              }),
            },
          );

          if (!response.ok) {
            const text = await response.text();
            const errorJSON = safelyParseJSON(text);

            if (!errorJSON) {
              throw new Error(text);
            }

            if (errorJSON.statusCode === 429) {
              return {
                html: `<html>
                <body style="margin: 0; text-align: center">
                <div style="display: flex; align-items: center; justify-content: center; flex-direction: column; height: 100vh; padding: 0 60px">
                  <div style="color:red">Too many requests today,</br>please try again tomorrow!</div>
                  </br>
                  </br>
                  <div>The daily AI limit is set by your administrators.</div>
                </div>
                </body>
                </html>`,
              };
            }

            throw new Error(errorJSON.message || text);
          }

          const reader = response.body?.getReader();

          if (!reader) {
            throw new Error("Generation failed (invalid response)");
          }

          let html = "";
          let streamError: Error | null = null;

          for await (const data of parseSSEStream(reader)) {
            if (data === "[DONE]") {
              break;
            }

            const chunk = safelyParseJSON(data) as StreamChunk | null;

            if (!chunk) {
              continue;
            }

            switch (chunk.type) {
              case "content": {
                if (chunk.delta) {
                  html += chunk.delta;
                  onPartial?.(html);
                }
                break;
              }
              case "error": {
                streamError = new Error(
                  chunk.error.message || "Generation failed",
                );
                break;
              }
              case "done": {
                break;
              }
            }
          }

          if (streamError) {
            throw streamError;
          }

          if (!html.trim()) {
            throw new Error("Generation failed (invalid response)");
          }

          return {
            html,
          };
        }}
      />

      <TTDDialog
        onTextSubmit={async (props) => {
          const { onChunk, onStreamCreated, signal, messages } = props;

          const result = await TTDStreamFetch({
            // intranet fork: the company's language model, via our server
            url: "/api/ai/text-to-diagram/chat-streaming",
            messages,
            onChunk,
            onStreamCreated,
            extractRateLimits: true,
            signal,
          });

          return result;
        }}
        persistenceAdapter={TTDIndexedDBAdapter}
      />
    </>
  );
};
