/**
 * Intranet fork: one realtime connection for presenting (phone remote P4,
 * live audience P6), separate from a scene's live collaboration. Opened on
 * first use, with the session cookie like every request.
 */
import type { Socket } from "socket.io-client";

let socket: Promise<Socket> | null = null;
let users = 0;

export const openPresentingSocket = async () => {
  users++;
  socket ??= import("socket.io-client").then(({ io }) =>
    io(import.meta.env.VITE_APP_WS_SERVER_URL || window.location.origin, {
      transports: ["websocket", "polling"],
    }),
  );
  return socket;
};

/** the last user closes it */
export const closePresentingSocket = () => {
  users = Math.max(0, users - 1);
  if (!users && socket) {
    const current = socket;
    socket = null;
    current.then((value) => value.close()).catch(() => {});
  }
};

/** an event with an answer from the server */
export const askServer = <T>(
  connection: Socket,
  event: string,
  ...args: unknown[]
) =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("Der Server antwortet nicht.")),
      10_000,
    );
    connection.emit(event, ...args, (answer: T) => {
      window.clearTimeout(timer);
      resolve(answer);
    });
  });

/** a key nobody guesses: 128 bits, URL-safe */
export const randomKey = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};
