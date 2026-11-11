/** error of a call to the intranet backend */
export class BackendError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "BackendError";
  }
}

export const SESSION_EXPIRED_MESSAGE =
  "Deine Anmeldung ist abgelaufen. Bitte lade die Seite neu, um dich wieder anzumelden.";

/**
 * fetch() against our own backend: same origin, session cookie included.
 * A 401 (session expired or ended elsewhere) becomes an error the UI shows;
 * the next page load leads through the login again.
 */
export const backendFetch = async (
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (response.status === 401) {
    throw new BackendError(401, SESSION_EXPIRED_MESSAGE);
  }
  return response;
};

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

export const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};
