/**
 * A stand-in for the company's SMTP relay: accepts every message (plain
 * SMTP, no TLS, no login) and keeps it for the test.
 */
import { createServer } from "node:net";

import type { AddressInfo } from "node:net";

export interface FakeMail {
  from: string;
  to: string[];
  data: string;
}

export const startFakeSmtp = async () => {
  const mails: FakeMail[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current: FakeMail = { from: "", to: [], data: "" };
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) {
            return;
          }
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          mails.push(current);
          current = { from: "", to: [], data: "" };
          inData = false;
          socket.write("250 queued\r\n");
          continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline < 0) {
          return;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const command = line.slice(0, 4).toUpperCase();
        if (command === "EHLO" || command === "HELO") {
          socket.write("250-fake\r\n250 8BITMIME\r\n");
        } else if (command === "MAIL") {
          current.from = line.replace(/^MAIL FROM:\s*/i, "");
          socket.write("250 OK\r\n");
        } else if (command === "RCPT") {
          current.to.push(line.replace(/^RCPT TO:\s*/i, ""));
          socket.write("250 OK\r\n");
        } else if (command === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (command === "QUIT") {
          socket.end("221 bye\r\n");
        } else {
          socket.write("250 OK\r\n");
        }
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    mails,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
