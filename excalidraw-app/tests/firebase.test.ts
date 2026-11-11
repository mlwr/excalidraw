import { vi } from "vitest";

import type { FileId } from "@excalidraw/element/types";

import { saveFilesToFirebase } from "../data/firebase";

// intranet fork: `firebase.ts` talks to excalidraw-server instead of Firebase

const files = [{ id: "file1" as FileId, buffer: new Uint8Array([1]) }];

const response = (status: number) =>
  ({ ok: status >= 200 && status < 300, status } as Response);

describe("saveFilesToFirebase", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads files to the backend file API", async () => {
    const fetchMock = vi.fn(async () => response(201));
    vi.stubGlobal("fetch", fetchMock);

    const result = await saveFilesToFirebase({
      prefix: "/files/shareLinks/abc",
      files,
    });

    expect(result).toEqual({ savedFiles: ["file1"], erroredFiles: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/share-links/abc/file1",
      expect.objectContaining({ method: "PUT", credentials: "same-origin" }),
    );
  });

  it("reports files the backend refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(413)),
    );

    const result = await saveFilesToFirebase({
      prefix: "/files/rooms/room1",
      files,
    });

    expect(result).toEqual({ savedFiles: [], erroredFiles: ["file1"] });
  });

  it("should reject when the backend is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(
      saveFilesToFirebase({ prefix: "/files/shareLinks/id", files }),
    ).rejects.toThrow();
  });

  it("asks for a new login when the session expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(401)),
    );

    await expect(
      saveFilesToFirebase({ prefix: "/files/shareLinks/id", files }),
    ).rejects.toThrow(/Anmeldung ist abgelaufen/);
  });
});
