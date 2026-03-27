/**
 * Layout stability tests — verify that persistent UI elements (progress bar,
 * options, paragraph) don't jump between states or across questions.
 *
 * Uses Playwright to render GamePhase/ReviewGamePhase via a Vite-served test
 * harness, then measures element positions with getBoundingClientRect().
 *
 * Run: npx playwright test test/layout-stability.pw.mjs
 */
import { test, expect } from "@playwright/test";

/** Get the Y position of an element */
async function getTop(page, selector) {
  return page.locator(selector).first().evaluate(el => el.getBoundingClientRect().top);
}

/** Get bounding rect of an element */
async function getRect(page, selector) {
  return page.locator(selector).first().evaluate(el => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  });
}

// ── GamePhase layout stability ───────────────────────────────────────────────

test.describe("GamePhase layout stability", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/test/layout-harness.html");
    await page.click("#start-game");
    // Wait for the game UI to render
    await page.waitForSelector(".game-progress-bar");
  });

  test("progress bar does not move when selecting a wrong answer", async ({ page }) => {
    const before = await getRect(page, ".game-progress-bar");

    // Click a wrong answer (option index 1, 2, or 3 — correct is always 0)
    const wrongBtn = page.locator(".opt-btn").nth(1);
    await wrongBtn.click();

    // Hint should now be visible
    await expect(page.locator(".feedback-banner.hint")).toBeVisible();

    const after = await getRect(page, ".game-progress-bar");
    expect(after.top).toBe(before.top);
    expect(after.left).toBe(before.left);
  });

  test("progress bar does not move when selecting the correct answer", async ({ page }) => {
    const before = await getRect(page, ".game-progress-bar");

    // Click the correct answer (always index 0 in our fixtures)
    await page.locator(".opt-btn").first().click();

    const after = await getRect(page, ".game-progress-bar");
    expect(after.top).toBe(before.top);
    expect(after.left).toBe(before.left);
  });

  test("options grid does not move when hint appears", async ({ page }) => {
    const before = await getRect(page, ".options-grid");

    await page.locator(".opt-btn").nth(1).click();
    await expect(page.locator(".feedback-banner.hint")).toBeVisible();

    const after = await getRect(page, ".options-grid");
    expect(after.top).toBe(before.top);
    expect(after.left).toBe(before.left);
  });

  test("progress bar stays fixed across question transitions", async ({ page }) => {
    const before = await getRect(page, ".game-progress-bar");

    // Answer correctly — auto-advances after 1.2s
    await page.locator(".opt-btn").first().click();
    // Wait for the next question (vocab-word text changes)
    await page.waitForFunction(
      (prevWord) => {
        const el = document.querySelector(".vocab-word");
        return el && el.textContent !== prevWord;
      },
      await page.locator(".vocab-word").first().textContent(),
      { timeout: 3000 }
    );

    const after = await getRect(page, ".game-progress-bar");
    expect(after.top).toBe(before.top);
    expect(after.left).toBe(before.left);
  });

  test("paragraph text does not shift when hint appears", async ({ page }) => {
    const before = await getRect(page, ".paragraph-text");

    await page.locator(".opt-btn").nth(2).click();
    await expect(page.locator(".feedback-banner.hint")).toBeVisible();

    const after = await getRect(page, ".paragraph-text");
    expect(after.top).toBe(before.top);
  });
});

// ── ReviewGamePhase layout stability ─────────────────────────────────────────

test.describe("ReviewGamePhase layout stability", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/test/layout-harness.html");
    await page.click("#start-review");
    await page.waitForSelector(".game-progress-bar");
  });

  test("progress bar does not move when selecting a wrong answer", async ({ page }) => {
    const before = await getRect(page, ".game-progress-bar");

    await page.locator(".opt-btn").nth(1).click();
    await expect(page.locator(".feedback-banner.hint")).toBeVisible();

    const after = await getRect(page, ".game-progress-bar");
    expect(after.top).toBe(before.top);
    expect(after.left).toBe(before.left);
  });

  test("progress bar stays fixed across question transitions", async ({ page }) => {
    const before = await getRect(page, ".game-progress-bar");

    await page.locator(".opt-btn").first().click();
    await page.waitForFunction(
      (prevWord) => {
        const el = document.querySelector(".vocab-word");
        return el && el.textContent !== prevWord;
      },
      await page.locator(".vocab-word").first().textContent(),
      { timeout: 3000 }
    );

    const after = await getRect(page, ".game-progress-bar");
    expect(after.top).toBe(before.top);
    expect(after.left).toBe(before.left);
  });
});
