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
