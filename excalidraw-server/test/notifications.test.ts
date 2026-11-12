/**
 * Notifications (Z3): mentions, replies and shares, in the app and by
 * e-mail through the company's SMTP relay.
 */
import { afterEach, expect, it } from "vitest";

import { startFakeSmtp } from "./helpers/fakeSmtp.js";
import { bob, createTestEnv, describeWithDb, ORIGIN } from "./helpers/setup.js";

import type { FakeUser } from "./helpers/fakeOidc.js";
import type { TestEnv } from "./helpers/setup.js";

/** the body of a mail as people read it */
const decodeQuotedPrintable = (data: string) =>
  Buffer.from(
    data
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      ),
    "latin1",
  ).toString("utf8");

const carol: FakeUser = {
  sub: "carol",
  name: "Carol IT",
  email: "carol@example.test",
  groups: ["/IT"],
};
const erin: FakeUser = {
  sub: "erin",
  name: "Erin Architektur",
  email: "erin@example.test",
  groups: ["/IT/Architektur"],
};

describeWithDb("notifications", () => {
  let env: TestEnv;
  let smtp: Awaited<ReturnType<typeof startFakeSmtp>> | null = null;

  afterEach(async () => {
    await env?.close();
    await smtp?.close();
    smtp = null;
  });

  const person = async (user: FakeUser) => {
    const cookie = await env.login(user);
    const app = (method: string, url: string, payload?: unknown) =>
      env.built.app.inject({
        method: method as "GET",
        url,
        headers: { cookie, origin: ORIGIN },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
    const me = (await app("GET", "/api/auth/me")).json().user;
    const notifications = async () =>
      (await app("GET", "/api/notifications")).json() as {
        unread: number;
        notifications: {
          id: string;
          type: string;
          text: string;
          read: boolean;
          sceneId: string | null;
          threadId: string | null;
        }[];
      };
    return { app, id: me.id as string, notifications };
  };

  it("tells people about mentions, replies and shares in the app", async () => {
    env = await createTestEnv();
    const owner = await person(bob);
    const colleague = await person(carol);
    const architect = await person(erin);

    const scene = (
      await owner.app("POST", "/api/scenes", { name: "Plan" })
    ).json().scene;
    await owner.app("PUT", `/api/scenes/${scene.id}/grants`, {
      grants: [{ type: "user", principal: colleague.id, role: "editor" }],
    });
    await expect
      .poll(async () => (await colleague.notifications()).notifications)
      .toEqual([
        expect.objectContaining({
          type: "share",
          text: "Bob Beispiel hat „Plan“ mit dir geteilt",
          read: false,
          sceneId: scene.id,
        }),
      ]);
    // saving the same grants again tells nobody anything new
    await owner.app("PUT", `/api/scenes/${scene.id}/grants`, {
      grants: [{ type: "user", principal: colleague.id, role: "viewer" }],
    });

    const thread = (
      await owner.app("POST", `/api/scenes/${scene.id}/comments`, {
        text: "Budget bitte prüfen",
        x: 0,
        y: 0,
        mentions: [colleague.id],
      })
    ).json().thread;
    await colleague.app("POST", `/api/comment-threads/${thread.id}/comments`, {
      text: "Mache ich",
    });
    await expect
      .poll(async () =>
        (await owner.notifications()).notifications.map((item) => item.text),
      )
      .toEqual(["Carol IT hat in „Plan“ auf einen Kommentar geantwortet"]);
    const forColleague = await colleague.notifications();
    expect(forColleague.unread).toBe(2);
    expect(forColleague.notifications.map((item) => item.type)).toEqual([
      "mention",
      "share",
    ]);
    expect(forColleague.notifications[0].threadId).toBe(thread.id);

    // read one, then all
    const read = await colleague.app("POST", "/api/notifications/read", {
      ids: [forColleague.notifications[0].id],
    });
    expect(read.json().unread).toBe(1);
    expect(
      (
        await colleague.app("POST", "/api/notifications/read", { all: true })
      ).json().unread,
    ).toBe(0);
    expect(
      (await colleague.app("POST", "/api/notifications/read", { ids: ["x"] }))
        .statusCode,
    ).toBe(400);
    // nobody reads someone else's
    expect(
      (await owner.app("GET", "/api/notifications")).json().notifications
        .length,
    ).toBe(1);

    // a team collection shared with a group reaches its members
    const team = (
      await owner.app("POST", "/api/collections", { name: "Architektur" })
    ).json();
    await owner.app("PUT", `/api/collections/${team.id}/grants`, {
      grants: [
        { type: "user", principal: owner.id, role: "manager" },
        { type: "group", principal: "/IT/Architektur", role: "viewer" },
      ],
    });
    await expect
      .poll(async () =>
        (
          await architect.notifications()
        ).notifications.map((item) => item.text),
      )
      .toEqual([
        "Bob Beispiel hat die Collection „Architektur“ mit dir geteilt",
      ]);
    expect((await colleague.notifications()).unread).toBe(0);

    expect(
      (await colleague.app("GET", "/api/notifications/preferences")).json(),
    ).toEqual({
      emailAvailable: false,
      email: { mention: true, reply: true, share: true },
    });
  });

  it("e-mails what stays unread, once, through the relay", async () => {
    smtp = await startFakeSmtp();
    env = await createTestEnv({
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(smtp.port),
      SMTP_FROM: "excalidraw@intranet.example",
      NOTIFY_EMAIL_DELAY_MINUTES: "0",
    });
    const owner = await person(bob);
    const colleague = await person(carol);
    const share = async (name: string) => {
      const scene = (await owner.app("POST", "/api/scenes", { name })).json()
        .scene;
      await owner.app("PUT", `/api/scenes/${scene.id}/grants`, {
        grants: [{ type: "user", principal: colleague.id, role: "viewer" }],
      });
      return scene;
    };
    const first = await share("Plan");
    await owner.app("POST", `/api/scenes/${first.id}/comments`, {
      text: "Vertraulicher Inhalt",
      x: 0,
      y: 0,
      mentions: [colleague.id],
    });
    await share("Ablauf");
    await expect
      .poll(async () => (await colleague.notifications()).unread)
      .toBe(3);

    await env.built.jobs.run("emails");
    expect(smtp.mails).toHaveLength(1);
    const mail = smtp.mails[0];
    expect(mail.to).toEqual(["<carol@example.test>"]);
    expect(mail.data).toMatch(/Subject: Excalidraw: 3 neue Benachrichtigungen/);
    const text = decodeQuotedPrintable(mail.data);
    expect(text).toContain(`${ORIGIN}/s/${first.id}`);
    expect(text).toContain("Bob Beispiel hat dich in „Plan“ erwähnt");
    expect(text).toContain("notifications=settings");
    // no content of comments leaves by mail
    expect(text).not.toContain("Vertraulicher");

    // once only
    await env.built.jobs.run("emails");
    expect(smtp.mails).toHaveLength(1);

    // read in the app first: no mail
    await share("Gelesen");
    await expect
      .poll(async () => (await colleague.notifications()).unread)
      .toBe(4);
    await colleague.app("POST", "/api/notifications/read", { all: true });
    await env.built.jobs.run("emails");
    expect(smtp.mails).toHaveLength(1);

    // switched off: in the app only
    const preferences = await colleague.app(
      "PUT",
      "/api/notifications/preferences",
      { email: { share: false } },
    );
    expect(preferences.json()).toEqual({
      emailAvailable: true,
      email: { mention: true, reply: true, share: false },
    });
    await share("Ohne Mail");
    await expect
      .poll(async () => (await colleague.notifications()).unread)
      .toBe(1);
    await env.built.jobs.run("emails");
    expect(smtp.mails).toHaveLength(1);
  });
});
