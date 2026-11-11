/**
 * Browser end-to-end test of the intranet setup: built app + server +
 * PostgreSQL + (fake) Keycloak, driven with Playwright.
 *
 * Prerequisites: `yarn build:app:docker` (app in excalidraw-app/build) and
 * TEST_DATABASE_URL. Run with `yarn --cwd excalidraw-server e2e`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { alice, bob, createTestEnv, describeWithDb } from "../helpers/setup.js";

import type { FakeUser } from "../helpers/fakeOidc.js";

import type { TestEnv } from "../helpers/setup.js";
import type { Browser, BrowserContext, Page } from "playwright";

const APP_URL = "http://localhost:3999";
const STATIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../excalidraw-app/build",
);

const carolIT: FakeUser = {
  sub: "carol",
  name: "Carol IT",
  email: "carol@example.test",
  groups: ["/IT"],
};

const describeE2E = existsSync(path.join(STATIC_DIR, "index.html"))
  ? describeWithDb
  : describe.skip;

/** number of canvas pixels that differ from the background */
const drawnPixels = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.static");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      return -1;
    }
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      // background is white (255,255,255); count clearly darker pixels
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) {
        count++;
      }
    }
    return count;
  });

/** close the open dialog and wait until it is gone */
const closeDialog = async (page: Page) => {
  // the workspace's own dialogs (e.g. sharing a scene)
  if (await page.locator(".ws-dialog__backdrop").count()) {
    await page.click(".ws-dialog__close");
    await page.waitForSelector(".ws-dialog__backdrop", {
      state: "detached",
      timeout: 5000,
    });
    return;
  }
  if (!(await page.locator(".Modal__background").count())) {
    return;
  }
  const close = page.locator(".Modal__close");
  if (await close.isVisible()) {
    await close.click();
  } else {
    // dialogs without a close button close on a click next to them
    await page.locator(".Modal__background").click({
      position: { x: 5, y: 5 },
    });
  }
  try {
    await page.waitForSelector(".Modal__background", {
      state: "detached",
      timeout: 5000,
    });
  } catch (error) {
    if (process.env.E2E_SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${process.env.E2E_SCREENSHOT_DIR}/dialog-not-closed.png`,
      });
    }
    throw error;
  }
};

describeE2E("browser end-to-end", () => {
  let env: TestEnv;
  let browser: Browser;
  const external: string[] = [];
  const cspViolations: string[] = [];
  const pageErrors: string[] = [];

  const newContext = async (): Promise<BrowserContext> => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
    context.on("request", (request) => {
      const url = request.url();
      const allowed =
        url.startsWith(APP_URL) ||
        url.startsWith(env.oidc.issuer.replace(/\/realms\/.*$/, "")) ||
        url.startsWith("data:") ||
        url.startsWith("blob:");
      if (!allowed) {
        external.push(url);
      }
    });
    context.on("page", (page) => {
      page.on("console", (message) => {
        if (/Content Security Policy|Refused to/i.test(message.text())) {
          cspViolations.push(message.text());
        }
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
    });
    return context;
  };

  const openApp = async (context: BrowserContext, url = `${APP_URL}/local`) => {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector(".excalidraw .collab-button", {
      timeout: 30000,
    });
    return page;
  };

  beforeAll(async () => {
    env = await createTestEnv({ STATIC_DIR, PUBLIC_URL: APP_URL });
    await env.built.app.listen({ host: "localhost", port: 3999 });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });
  });

  afterAll(async () => {
    await browser?.close();
    await env?.close();
  });

  const openDashboard = async (context: BrowserContext) => {
    const page = await context.newPage();
    await page.goto(`${APP_URL}/`);
    await page.waitForSelector(".ws-dashboard .ws-main h1", { timeout: 30000 });
    return page;
  };

  const drawRectangle = async (page: Page, x: number, y: number) => {
    await page.keyboard.press("r");
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 180, y + 120, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press("Escape");
  };

  it("logs in, collaborates live, shares links and stays inside the network", async () => {
    // --- Alice logs in via Keycloak and draws a rectangle -------------------
    env.oidc.setUser(alice);
    const aliceContext = await newContext();
    const alicePage = await openApp(aliceContext);
    expect(new URL(alicePage.url()).origin).toBe(APP_URL);

    await alicePage.click("[data-testid='main-menu-trigger']");
    await expect(
      alicePage.getByText("Abmelden (Alice Admin)").isVisible(),
    ).resolves.toBe(true);
    await alicePage.keyboard.press("Escape");

    await alicePage.keyboard.press("r");
    await alicePage.mouse.move(400, 300);
    await alicePage.mouse.down();
    await alicePage.mouse.move(600, 450, { steps: 5 });
    await alicePage.mouse.up();
    await alicePage.keyboard.press("Escape");
    expect(await drawnPixels(alicePage)).toBeGreaterThan(100);

    // --- Alice exports a read-only share link ----------------------------------
    await alicePage.click(".collab-button");
    await alicePage.getByText("Export to Link").click();
    const linkInput = alicePage.locator(".ShareableLinkDialog input");
    await linkInput.waitFor({ timeout: 15000 });
    const shareUrl = await linkInput.inputValue();
    expect(shareUrl).toMatch(/#json=[\w-]+,[\w-]+$/);
    await closeDialog(alicePage);

    // --- Alice starts a live session ----------------------------------------
    await alicePage.click(".collab-button");
    await alicePage.getByText("Start session").click();
    await alicePage.waitForFunction(() => location.hash.startsWith("#room="));
    const roomUrl = alicePage.url();
    await closeDialog(alicePage);

    // --- Bob opens the room link, logs in and sees Alice's drawing ----------
    env.oidc.setUser(bob);
    const bobContext = await newContext();
    const bobPage = await openApp(bobContext, roomUrl);
    // the encryption key survived the login round trip (sessionStorage)
    expect(bobPage.url()).toBe(roomUrl);
    await bobPage.waitForFunction(
      () =>
        document.querySelector(".CollabButton-collaborators")?.textContent ===
        "2",
      undefined,
      { timeout: 20000 },
    );
    await expect
      .poll(() => drawnPixels(bobPage), { timeout: 15000 })
      .toBeGreaterThan(100);

    // the server stored the room scene (end-to-end encrypted)
    const roomId = new URL(roomUrl).hash.match(/#room=([^,]+),/)![1];
    await expect
      .poll(
        async () =>
          (
            await env.built.ctx.db
              .selectFrom("rooms")
              .select("id")
              .where("id", "=", roomId)
              .executeTakeFirst()
          )?.id,
        { timeout: 15000 },
      )
      .toBe(roomId);

    // --- a third browser opens the share link ----------------------------------
    env.oidc.setUser(bob);
    const sharePage = await openApp(await newContext(), shareUrl);
    await expect
      .poll(() => drawnPixels(sharePage), { timeout: 15000 })
      .toBeGreaterThan(100);

    // --- Alice logs out (app session and Keycloak session) -------------------
    await closeDialog(alicePage);
    await alicePage.click("[data-testid='main-menu-trigger']");
    await alicePage.getByText("Abmelden (Alice Admin)").click();
    await alicePage.waitForURL(/\/logout\?/, { timeout: 15000 });
    const me = await aliceContext.request.get(`${APP_URL}/api/auth/me`);
    expect(me.status()).toBe(401);

    // --- nothing left the network, nothing was blocked -----------------------
    expect(external).toEqual([]);
    expect(cspViolations).toEqual([]);
    expect(pageErrors).toEqual([]);
  }, 120000);

  it("runs the workspace: collections, groups, live editing, read-only links", async () => {
    // Carol (Keycloak group /IT) logs in once, so the group is known
    env.oidc.setUser(carolIT);
    const carolContext = await newContext();
    await openDashboard(carolContext);

    // --- Alice creates a team collection for the group /IT ------------------
    env.oidc.setUser(alice);
    const aliceContext = await newContext();
    const dashboard = await openDashboard(aliceContext);
    await dashboard.click("button[aria-label='Neue Collection']");
    await dashboard.fill(".ws-dialog input", "Architektur");
    await dashboard.click(".ws-dialog__footer .ws-button--primary");
    await dashboard.waitForSelector("h1:has-text('Architektur')");

    await dashboard.click("text=Zugriff verwalten");
    await dashboard.selectOption(".ws-access__add select", "editor");
    await dashboard.fill(".ws-access__search input", "IT");
    await dashboard.click(".ws-access__suggestions button:has-text('/IT')");
    await dashboard.click(".ws-dialog__footer .ws-button--primary");
    await dashboard.waitForSelector(".ws-dialog", { state: "detached" });

    // --- Alice creates a scene there and draws -------------------------------
    await dashboard.click(".ws-main__actions >> text=Neue Szene");
    await dashboard.waitForURL(/\/s\/[\w-]+$/);
    const sceneUrl = dashboard.url();
    // the empty scene finished loading once the welcome screen shows
    await dashboard.waitForSelector(".welcome-screen-center", {
      timeout: 30000,
    });
    await drawRectangle(dashboard, 350, 250);
    const alicePixels = await drawnPixels(dashboard);
    expect(alicePixels).toBeGreaterThan(100);

    // --- Carol sees it in the collection and edits it live --------------------
    const carolPage = await carolContext.newPage();
    await carolPage.goto(sceneUrl);
    await carolPage.waitForSelector(".excalidraw .collab-button", {
      timeout: 30000,
    });
    await expect
      .poll(() => drawnPixels(carolPage), { timeout: 15000 })
      .toBeGreaterThan(100);
    await carolPage.waitForFunction(
      () =>
        document.querySelector(".CollabButton-collaborators")?.textContent ===
        "2",
      undefined,
      { timeout: 20000 },
    );
    await drawRectangle(carolPage, 650, 250);
    await expect
      .poll(() => drawnPixels(dashboard), { timeout: 15000 })
      .toBeGreaterThan(alicePixels + 100);

    // --- Bob has no access ------------------------------------------------------
    env.oidc.setUser(bob);
    const bobContext = await newContext();
    const bobPage = await bobContext.newPage();
    await bobPage.goto(sceneUrl);
    await bobPage.waitForSelector("text=Szene nicht gefunden", {
      timeout: 30000,
    });

    // --- Alice turns on the read-only link, Bob can only look -----------------
    await dashboard.click(".collab-button");
    // the switch flips once the server created the link
    await dashboard.click(".ws-toggle input");
    const readLinkInput = dashboard.locator(
      "input[aria-label='Nur-Lese-Link']",
    );
    await readLinkInput.waitFor();
    const readLink = await readLinkInput.inputValue();
    expect(readLink).toMatch(new RegExp(`^${APP_URL}/v/[\\w-]+$`));
    await closeDialog(dashboard);

    await bobPage.goto(readLink);
    await bobPage.waitForURL(sceneUrl, { timeout: 30000 });
    await bobPage.waitForSelector(
      ".ws-editor-nav .ws-badge:has-text('Nur Ansicht')",
      {
        timeout: 30000,
      },
    );
    await expect
      .poll(() => drawnPixels(bobPage), { timeout: 15000 })
      .toBeGreaterThan(alicePixels + 100);
    // view mode: no drawing tools at all
    expect(
      await bobPage.locator("[data-testid='toolbar-rectangle']").count(),
    ).toBe(0);

    // --- the dashboard shows a thumbnail and who is drawing -------------------
    const overview = await openDashboard(aliceContext);
    await overview.click(".ws-sidebar >> text=Architektur");
    await expect
      .poll(
        async () => {
          await overview.reload();
          return overview.locator(".ws-card img").count();
        },
        { timeout: 60000, interval: 3000 },
      )
      .toBe(1);
    await overview.waitForSelector(".ws-card__live");

    // --- Alice turns the link off: Bob's open view ends right away ----------
    await dashboard.click(".collab-button");
    await dashboard.click(".ws-toggle input");
    await readLinkInput.waitFor({ state: "detached" });
    await closeDialog(dashboard);
    await bobPage.waitForSelector("text=Szene nicht gefunden", {
      timeout: 30000,
    });

    expect(external).toEqual([]);
    expect(cspViolations).toEqual([]);
    expect(pageErrors).toEqual([]);
  }, 180000);

  it("issues API tokens, shows API changes live and keeps comments", async () => {
    const shot = async (page: Page, name: string) => {
      if (process.env.E2E_SCREENSHOT_DIR) {
        await page.screenshot({
          path: `${process.env.E2E_SCREENSHOT_DIR}/${name}.png`,
        });
      }
    };

    // --- Bob creates a write token in the dashboard -------------------------
    env.oidc.setUser(bob);
    const bobContext = await newContext();
    const dashboard = await openDashboard(bobContext);
    await dashboard.getByRole("button", { name: "API-Tokens" }).click();
    await dashboard.fill(".ws-token-form input", "E2E-Skript");
    await dashboard.selectOption(".ws-token-form select >> nth=0", "write");
    await dashboard.getByRole("button", { name: "Token erzeugen" }).click();
    const tokenField = dashboard.locator(
      "textarea[aria-label='Neues API-Token']",
    );
    await tokenField.waitFor();
    const token = await tokenField.inputValue();
    expect(token).toMatch(/^exc_/);
    await expect(dashboard.locator(".ws-table tbody tr").count()).resolves.toBe(
      1,
    );
    await shot(dashboard, "api-tokens");
    await closeDialog(dashboard);

    const api = async (method: string, url: string, body?: unknown) => {
      const response = await fetch(`${APP_URL}/api/v1${url}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(response.ok).toBe(true);
      return response.json();
    };

    // --- a script draws a diagram through the API ---------------------------
    const { scene } = await api("POST", "/scenes", { name: "Per API" });
    await api("POST", `/scenes/${scene.id}/diagram`, {
      direction: "LR",
      nodes: [
        { id: "a", label: "Antrag", shape: "ellipse" },
        { id: "b", label: "Prüfung", shape: "diamond" },
        { id: "c", label: "Bescheid" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c", label: "ok" },
      ],
    });

    const bobPage = await bobContext.newPage();
    await bobPage.goto(scene.url);
    await bobPage.waitForSelector(".ws-editor-nav__title:has-text('Per API')", {
      timeout: 30000,
    });
    await expect
      .poll(() => drawnPixels(bobPage), { timeout: 15000 })
      .toBeGreaterThan(2000);
    const before = await drawnPixels(bobPage);
    await shot(bobPage, "api-diagram");

    // Carol (group /IT) may look at it
    await bobPage.evaluate(
      (id) =>
        fetch(`/api/scenes/${id}/grants`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grants: [{ type: "group", principal: "/IT", role: "viewer" }],
          }),
        }),
      scene.id,
    );
    env.oidc.setUser(carolIT);
    const carolContext = await newContext();
    const carolPage = await carolContext.newPage();
    await carolPage.goto(scene.url);
    await carolPage.waitForSelector(".ws-badge:has-text('Nur Ansicht')", {
      timeout: 30000,
    });
    await expect
      .poll(() => drawnPixels(carolPage), { timeout: 15000 })
      .toBeGreaterThan(2000);

    // --- an API change appears in both open editors right away ---------------
    await api("POST", `/scenes/${scene.id}/elements`, {
      elements: [
        {
          type: "rectangle",
          x: -400,
          y: -300,
          width: 260,
          height: 120,
          backgroundColor: "#ffc9c9",
          fillStyle: "solid",
          label: { text: "Live aus der API" },
        },
      ],
    });
    await expect
      .poll(() => drawnPixels(bobPage), { timeout: 15000 })
      .toBeGreaterThan(before + 1000);

    // --- Bob comments on the canvas, Carol sees it live and answers ----------
    await bobPage.click(".ws-comments-button");
    await bobPage.getByRole("button", { name: "Kommentar hinzufügen" }).click();
    await bobPage.waitForSelector(".ws-comments-layer.is-placing");
    await bobPage.mouse.click(640, 420);
    await bobPage.fill(
      ".ws-comment-popover textarea",
      "Fehlt hier nicht die Fristprüfung?",
    );
    await bobPage
      .locator(".ws-comment-popover")
      .getByRole("button", { name: "Kommentieren" })
      .click();
    await bobPage.waitForSelector(".ws-comment-pin");
    await shot(bobPage, "comment-created");

    const carolPin = carolPage.locator(".ws-comment-pin");
    await carolPin.waitFor({ timeout: 15000 });
    await carolPin.click();
    await carolPage.waitForSelector(
      ".ws-comment-popover >> text=Fehlt hier nicht die Fristprüfung?",
    );
    await carolPage.fill(
      ".ws-comment-popover textarea",
      "Doch – nehme ich auf.",
    );
    await carolPage
      .locator(".ws-comment-popover")
      .getByRole("button", { name: "Antworten" })
      .click();
    await carolPage.waitForSelector(
      ".ws-comment-popover >> text=Doch – nehme ich auf.",
    );
    await shot(carolPage, "comment-reply");

    // Bob's pin counts both, and Bob resolves the thread
    await bobPage.waitForSelector(".ws-comment-pin__count:has-text('2')", {
      timeout: 15000,
    });
    // Bob's thread is still open and got the reply live
    await bobPage.waitForSelector(
      ".ws-comment-popover >> text=Doch – nehme ich auf.",
    );
    await bobPage
      .locator(".ws-comment-popover")
      .getByRole("button", { name: "Erledigt" })
      .click();
    await bobPage.waitForSelector(".ws-tab:has-text('Erledigt (1)')");
    // Carol sees it resolved right away (her open thread stays, greyed out)
    await carolPage.waitForSelector(".ws-comment-pin.is-resolved", {
      timeout: 15000,
    });
    await carolPage.locator(".ws-comment-popover .ws-dialog__close").click();
    await carolPage.waitForSelector(".ws-comment-pin", { state: "detached" });

    expect(external).toEqual([]);
    expect(cspViolations).toEqual([]);
    expect(pageErrors).toEqual([]);
  }, 180000);

  it("saves a drawing from the local editor into the workspace", async () => {
    env.oidc.setUser(bob);
    const context = await newContext();
    const page = await openApp(context);
    await page.waitForSelector(".welcome-screen-center", { timeout: 30000 });
    await drawRectangle(page, 400, 300);

    await page.click("[data-testid='main-menu-trigger']");
    await page.getByText("Im Workspace speichern").click();
    await page.fill(".ws-dialog input", "Aus dem Browser");
    await page.click(".ws-dialog__footer .ws-button--primary");
    await page.waitForURL(/\/s\/[\w-]+$/, { timeout: 30000 });
    await page.waitForSelector(
      ".ws-editor-nav__title:has-text('Aus dem Browser')",
    );
    await expect
      .poll(() => drawnPixels(page), { timeout: 15000 })
      .toBeGreaterThan(100);

    expect(external).toEqual([]);
    expect(cspViolations).toEqual([]);
    expect(pageErrors).toEqual([]);
  }, 120000);
});
