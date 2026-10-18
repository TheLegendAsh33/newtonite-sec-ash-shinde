import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { attachScenarioJourney, authenticatedSession as signIn, finishSessionArtifacts } from "./session-artifacts";

const API_BASE = process.env.E2E_API_URL ?? "http://localhost:8001/api";
const DEMO_USERS = {
  morgan: { name: "Morgan Chen", email: "morgan@newtonite.local", password: "Morgan2026!", teams: { "Support Operations": "admin", Payments: "lead" } },
  jordan: { name: "Jordan Patel", email: "jordan@newtonite.local", password: "Jordan2026!", teams: { "Support Operations": "lead" } },
  casey: { name: "Casey Rivera", email: "casey@newtonite.local", password: "Casey2026!", teams: { "Support Operations": "member" } },
  taylor: { name: "Taylor Brooks", email: "taylor@newtonite.local", password: "Taylor2026!", teams: { Payments: "member" } },
};

// These multi-user scenarios own capture per authenticated actor. The default
// fixture recorder would also capture sign-in and cannot record manual videos.
test.use({ trace: "off", screenshot: "off", video: "off" });

type ApiResult<T = unknown> = { status: number; body: T };
type Team = { id: string; name: string; role: string };
type WorkItem = { id: string; team_id: string; title: string; owner_id: string | null; version: number; status: string; priority: string; history?: Array<{ event_type: string }> };

test.beforeEach(attachScenarioJourney);
test.afterEach(finishSessionArtifacts);

async function attachScreen(page: Page, name: string): Promise<void> {
  // A fixed dialog sits above a scrolled queue. A full-page capture would add a
  // long, undimmed background below it, making the actual test state hard to read.
  const dialogOpen = await page.getByRole("dialog").count() > 0;
  await test.info().attach(name, {
    body: await page.screenshot({ fullPage: !dialogOpen, animations: "disabled" }),
    contentType: "image/png",
  });
}

async function attachOutcome(name: string, outcome: unknown): Promise<void> {
  await test.info().attach(name, {
    body: JSON.stringify(outcome, null, 2),
    contentType: "application/json",
  });
}

async function api<T = unknown>(
  page: Page,
  path: string,
  options: { method?: string; body?: Record<string, unknown>; idempotencyKey?: string } = {},
): Promise<ApiResult<T>> {
  return page.evaluate(async ({ apiBase, endpoint, method, body, idempotencyKey }) => {
    const headers: Record<string, string> = {};
    if (body) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const response = await fetch(`${apiBase}${endpoint}`, {
      method,
      credentials: "include",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  }, {
    apiBase: API_BASE,
    endpoint: path,
    method: options.method ?? "GET",
    body: options.body,
    idempotencyKey: options.idempotencyKey,
  }) as Promise<ApiResult<T>>;
}

async function supportTeamId(page: Page): Promise<string> {
  const response = await api<Team[]>(page, "/teams");
  expect(response.status).toBe(200);
  const team = response.body.find((entry) => entry.name === "Support Operations");
  expect(team, "seeded Support Operations team").toBeTruthy();
  return team!.id;
}

async function selectSupportTeam(page: Page): Promise<void> {
  await page.getByLabel("Viewing team").selectOption({ label: "Support Operations" });
  await expect(page.locator(".team-mini")).toContainText("Support Operations");
}

async function createItem(page: Page, teamId: string, title: string): Promise<WorkItem> {
  const response = await api<WorkItem>(page, "/items", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: {
      team_id: teamId,
      title,
      purpose: "Playwright verifies safe collaboration against an isolated test database.",
      priority: "high",
    },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}

async function moveItem(page: Page, item: WorkItem, status: string): Promise<WorkItem> {
  const result = await api<WorkItem>(page, `/items/${item.id}`, {
    method: "PATCH",
    body: { expected_version: item.version, status },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

async function openItem(page: Page, title: string) {
  await page.getByText(title, { exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Item details")).toBeVisible();
  return dialog;
}

function uniqueTitle(prefix: string): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}

test("Sign-in: each reviewer sees only their assigned teams and role", async ({ browser }) => {
  for (const account of Object.values(DEMO_USERS)) {
    const { page } = await signIn(browser, account);
    await test.step(`Verify ${account.name}'s team access`, async () => {
      const response = await api<Team[]>(page, "/teams");
      expect(response.status).toBe(200);
      expect(Object.fromEntries(response.body.map((team) => [team.name, team.role]))).toEqual(account.teams);
    });
    await attachScreen(page, `${account.name} workspace`);
  }
});

test("Work claiming: two teammates racing produce one owner and one history event", async ({ browser }) => {
  const jordan = await signIn(browser, DEMO_USERS.jordan);
  const casey = await signIn(browser, DEMO_USERS.casey);
  const teamId = await supportTeamId(jordan.page);
  const item = await createItem(jordan.page, teamId, uniqueTitle("E2E simultaneous claim"));

  const dialogs = await test.step("Open the same unassigned item in both browser sessions", async () => {
    await Promise.all([jordan.page.reload(), casey.page.reload()]);
    await selectSupportTeam(jordan.page);
    await selectSupportTeam(casey.page);
    await expect(jordan.page.getByText(item.title, { exact: true })).toBeVisible();
    await expect(casey.page.getByText(item.title, { exact: true })).toBeVisible();
    const [jordanDialog, caseyDialog] = await Promise.all([
      openItem(jordan.page, item.title),
      openItem(casey.page, item.title),
    ]);
    return { jordanDialog, caseyDialog };
  });

  const claimStatuses = await test.step("Race both Claim buttons at the same time", async () => {
    const claimResponse = (page: Page) => page.waitForResponse((response) =>
      response.url() === `${API_BASE}/items/${item.id}/claim` && response.request().method() === "POST",
    );
    const jordanClaimResponse = claimResponse(jordan.page);
    const caseyClaimResponse = claimResponse(casey.page);
    await Promise.all([
      dialogs.jordanDialog.getByRole("button", { name: "Claim work" }).click(),
      dialogs.caseyDialog.getByRole("button", { name: "Claim work" }).click(),
    ]);
    const [jordanClaim, caseyClaim] = await Promise.all([jordanClaimResponse, caseyClaimResponse]);
    const statuses = [jordanClaim.status(), caseyClaim.status()].sort();
    expect(statuses).toEqual([200, 409]);
    return statuses;
  });

  await test.step("Confirm one owner and one claim history entry", async () => {
    const latest = await api<WorkItem>(jordan.page, `/items/${item.id}`);
    expect(latest.status).toBe(200);
    expect(latest.body.owner_id).toBeTruthy();
    expect(latest.body.version).toBe(2);
    expect(latest.body.history?.filter((entry) => entry.event_type === "claimed")).toHaveLength(1);
  });
  await attachOutcome("Claim race result", { responseStatuses: claimStatuses, expected: "one winner (200), one conflict (409)" });
  await attachScreen(jordan.page, "Jordan browser session after race");
  await attachScreen(casey.page, "Casey browser session after race");
});

test("Stale edits: an older change is rejected without overwriting the latest update", async ({ browser }) => {
  const morgan = await signIn(browser, DEMO_USERS.morgan);
  await selectSupportTeam(morgan.page);
  const teamId = await supportTeamId(morgan.page);
  const item = await createItem(morgan.page, teamId, uniqueTitle("E2E stale version"));
  await morgan.page.reload();
  await selectSupportTeam(morgan.page);

  const jordan = await signIn(browser, DEMO_USERS.jordan);
  await selectSupportTeam(jordan.page);
  const dialogs = await test.step("Both teammates open version 1 of the same item", async () => {
    await expect(morgan.page.getByText(item.title, { exact: true })).toBeVisible();
    const [morganDialog, jordanDialog] = await Promise.all([
      openItem(morgan.page, item.title),
      openItem(jordan.page, item.title),
    ]);
    await expect(morganDialog.getByText("Work item · Version 1")).toBeVisible();
    await expect(jordanDialog.getByText("Work item · Version 1")).toBeVisible();
    return { morganDialog, jordanDialog };
  });

  await test.step("Morgan saves the first change and advances the version", async () => {
    await dialogs.morganDialog.getByLabel("Status", { exact: true }).selectOption("in_progress");
    await dialogs.morganDialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialogs.morganDialog.getByText("Work item · Version 2")).toBeVisible();
  });

  await test.step("Jordan's stale save shows a conflict", async () => {
    await dialogs.jordanDialog.getByLabel("Priority", { exact: true }).selectOption("urgent");
    await dialogs.jordanDialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialogs.jordanDialog.getByText(/Someone else changed this item/)).toBeVisible();
  });

  await test.step("Confirm the first update remains intact", async () => {
    const latest = await api<WorkItem>(morgan.page, `/items/${item.id}`);
    expect(latest.body).toMatchObject({ status: "in_progress", priority: "high", version: 2 });
  });
  await attachScreen(jordan.page, "Conflict shown in Jordan's browser");
});

test("Member permissions: a member cannot edit another teammate's work", async ({ browser }) => {
  const morgan = await signIn(browser, DEMO_USERS.morgan);
  await selectSupportTeam(morgan.page);
  const teamId = await supportTeamId(morgan.page);
  const item = await createItem(morgan.page, teamId, uniqueTitle("E2E authorization"));
  await morgan.page.reload();
  await selectSupportTeam(morgan.page);

  const casey = await signIn(browser, DEMO_USERS.casey);
  await selectSupportTeam(casey.page);
  await test.step("Check the member's read-only item controls", async () => {
    await expect(casey.page.getByText(item.title, { exact: true })).toBeVisible();
    const itemDialog = await openItem(casey.page, item.title);
    await expect(itemDialog.getByLabel("Status", { exact: true })).toBeDisabled();
    await expect(itemDialog.getByLabel("Priority", { exact: true })).toBeDisabled();
    await expect(itemDialog.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await expect(itemDialog.getByRole("button", { name: "Claim work" })).toBeEnabled();
  });

  const forbidden = await test.step("Try the protected API request as the same member", async () => {
    const response = await api(casey.page, `/items/${item.id}`, {
      method: "PATCH",
      body: { expected_version: item.version, priority: "urgent" },
    });
    expect(response.status).toBe(403);
    expect((response.body as { detail: { code: string } }).detail.code).toBe("forbidden");
    return response;
  });

  await test.step("Confirm the work item was not changed", async () => {
    const latest = await api<WorkItem>(morgan.page, `/items/${item.id}`);
    expect(latest.body).toMatchObject({ priority: "high", version: 1, owner_id: null });
  });
  await attachOutcome("Member edit response", { status: forbidden.status, expected: "403 forbidden" });
  await attachScreen(casey.page, "Member view of read-only work");
});

test("Safe API retries: duplicate create requests save one work item", async ({ browser }) => {
  const morgan = await signIn(browser, DEMO_USERS.morgan);
  await selectSupportTeam(morgan.page);
  const teamId = await supportTeamId(morgan.page);
  const title = uniqueTitle("E2E idempotent create");
  const payload = {
    team_id: teamId,
    title,
    purpose: "Two identical Chromium requests share an idempotency key.",
    priority: "high",
  };
  const key = randomUUID();

  const [first, duplicate] = await test.step("Send two identical creates at the same time", async () => {
    const results = await Promise.all([
      api<WorkItem>(morgan.page, "/items", { method: "POST", body: payload, idempotencyKey: key }),
      api<WorkItem>(morgan.page, "/items", { method: "POST", body: payload, idempotencyKey: key }),
    ]);
    expect(results.map((result) => result.status)).toEqual([201, 201]);
    expect(results[0].body.id).toBe(results[1].body.id);
    return results;
  });

  const list = await test.step("Confirm only one item was stored", async () => {
    const result = await api<{ total: number; items: WorkItem[] }>(
      morgan.page,
      `/items?team_id=${teamId}&q=${encodeURIComponent(title)}&page=1&page_size=50`,
    );
    expect(result.body.total).toBe(1);
    expect(result.body.items).toHaveLength(1);
    return result;
  });

  const changedPayload = await test.step("Reuse the key with different content and expect a conflict", async () => {
    const result = await api(morgan.page, "/items", {
      method: "POST",
      body: { ...payload, title: `${title} changed` },
      idempotencyKey: key,
    });
    expect(result.status).toBe(409);
    expect((result.body as { detail: { code: string } }).detail.code).toBe("idempotency_key_reused");
    return result;
  });
  await attachOutcome("Idempotency result", {
    firstStatus: first.status,
    duplicateStatus: duplicate.status,
    sameWorkItem: first.body.id === duplicate.body.id,
    storedCount: list.body.total,
    changedPayloadStatus: changedPayload.status,
  });
});

test("Create form retries: the UI sends a key that can be replayed safely", async ({ browser }) => {
  const morgan = await signIn(browser, DEMO_USERS.morgan);
  await selectSupportTeam(morgan.page);
  const teamId = await supportTeamId(morgan.page);
  let createRequest: import("@playwright/test").Request | undefined;
  morgan.page.on("request", (request) => {
    if (request.method() === "POST" && request.url() === `${API_BASE}/items`) createRequest = request;
  });

  const title = uniqueTitle("E2E UI create");
  const purpose = "The UI-generated request key makes a retry safe.";
  const createResponse = await test.step("Create a high-priority item through the form", async () => {
    await morgan.page.getByRole("button", { name: "New work item" }).click();
    await morgan.page.getByLabel("What needs attention?").fill(title);
    await morgan.page.getByLabel("Purpose and context").fill(purpose);
    await morgan.page.getByLabel("Priority", { exact: true }).selectOption("high");
    const responsePromise = morgan.page.waitForResponse((response) => response.url() === `${API_BASE}/items` && response.request().method() === "POST");
    await morgan.page.getByRole("button", { name: "Create work item" }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    await expect(morgan.page.getByRole("dialog").getByText(title, { exact: true })).toBeVisible();
    return response;
  });

  const key = createRequest?.headers()["idempotency-key"];
  expect(key).toMatch(/^[0-9a-f-]{36}$/i);
  await attachScreen(morgan.page, "Created item shown in the details dialog");
  const payload = { team_id: teamId, title, purpose, priority: "high" };
  const [replayA, replayB] = await test.step("Replay the same request twice with the captured key", async () => {
    const results = await Promise.all([
      api<WorkItem>(morgan.page, "/items", { method: "POST", body: payload, idempotencyKey: key! }),
      api<WorkItem>(morgan.page, "/items", { method: "POST", body: payload, idempotencyKey: key! }),
    ]);
    expect(results.map((result) => result.status)).toEqual([201, 201]);
    expect(results[0].body.id).toBe(results[1].body.id);
    return results;
  });

  const list = await test.step("Confirm the search returns a single saved item", async () => {
    const result = await api<{ total: number }>(
      morgan.page,
      `/items?team_id=${teamId}&q=${encodeURIComponent(title)}&page=1&page_size=50`,
    );
    expect(result.body.total).toBe(1);
    return result;
  });
  await attachOutcome("Create retry result", {
    formCreateStatus: createResponse.status(),
    replayStatuses: [replayA.status, replayB.status],
    sameWorkItem: replayA.body.id === replayB.body.id,
    storedCount: list.body.total,
  });
});

test("Visual queue: lifecycle filters and board columns show the same work", async ({ browser }) => {
  const { page } = await signIn(browser, DEMO_USERS.morgan);
  await selectSupportTeam(page);
  const teamId = await supportTeamId(page);
  const item = await createItem(page, teamId, uniqueTitle("E2E visual queue"));
  const inProgress = await moveItem(page, item, "in_progress");
  await moveItem(page, inProgress, "blocked");
  await page.reload();
  await selectSupportTeam(page);

  await test.step("Select Blocked in the graphical lifecycle", async () => {
    const blockedFilter = page.getByRole("button", { name: /^Filter queue by Blocked;/ });
    await blockedFilter.focus();
    await page.keyboard.press("Enter");
    await expect(blockedFilter).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Filter by status", { exact: true })).toHaveValue("blocked");
    await expect(page.locator(".item-row").filter({ hasText: item.title })).toBeVisible();
    await expect(page.locator(".item-row .status-pill").filter({ hasNotText: /^Blocked$/ })).toHaveCount(0);
  });
  await attachScreen(page, "Lifecycle filter selects blocked work");

  await test.step("Switch to the board while keeping the active status filter", async () => {
    await page.getByRole("button", { name: "Board view", exact: true }).click();
    await expect(page.getByRole("button", { name: "Board view", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".work-board .board-card").filter({ hasText: item.title })).toBeVisible();
    await expect(page.locator('.work-board .board-card:not([data-status="blocked"])')).toHaveCount(0);
  });
  await attachScreen(page, "Board view retains the selected lifecycle step");

  await test.step("Clear the lifecycle filter and return to the list", async () => {
    await page.getByRole("button", { name: /^Filter queue by Blocked;/ }).click();
    await expect(page.getByLabel("Filter by status", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "List view", exact: true }).click();
    await expect(page.getByRole("button", { name: "List view", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".item-row").filter({ hasText: item.title })).toBeVisible();
  });
});

test("Item journey: historical visits reflect actual changes and preserve skipped stages", async ({ browser }) => {
  const { page } = await signIn(browser, DEMO_USERS.morgan);
  await selectSupportTeam(page);
  const teamId = await supportTeamId(page);
  let item = await createItem(page, teamId, uniqueTitle("E2E actual journey"));
  await test.step("Take the blocked/resume route and finish without review", async () => {
    for (const status of ["in_progress", "blocked", "in_progress", "done"]) {
      item = await moveItem(page, item, status);
    }
  });
  await page.reload();
  await selectSupportTeam(page);

  await test.step("Read the recorded journey in item details", async () => {
    const dialog = await openItem(page, item.title);
    const workflow = dialog.locator(".item-workflow-detail");
    await expect(workflow).toBeVisible();
    await expect(workflow.locator('[data-status="done"]')).toHaveClass(/is-current/);
    await expect(workflow.locator('[data-status="open"]')).toHaveAttribute("data-visited", "true");
    await expect(workflow.locator('[data-status="in_progress"]')).toHaveAttribute("data-visited", "true");
    await expect(workflow.locator('[data-status="blocked"]')).toHaveAttribute("data-visited", "true");
    await expect(workflow.locator('[data-status="in_review"]')).toHaveAttribute("data-visited", "false");
    await expect(workflow.locator('[data-status="in_review"]')).not.toHaveClass(/is-visited/);
  });
  await attachScreen(page, "Actual journey includes blocked and leaves review unvisited");
  await attachOutcome("Recorded journey", { transitions: ["open", "in_progress", "blocked", "in_progress", "done"], skippedStage: "in_review" });
});

test("Small screens and keyboard: dialogs keep focus inside and restore the trigger", async ({ browser }) => {
  const { page } = await signIn(browser, DEMO_USERS.morgan);
  await selectSupportTeam(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await test.step("Keep every phone queue field inside its work item card", async () => {
    await expect(page.locator(".item-row").first()).toBeVisible();
    const overflow = await page.locator(".item-row").evaluateAll((rows) => rows.flatMap((row) => {
      const card = row.getBoundingClientRect();
      return Array.from(row.querySelectorAll(":scope > .item-title, :scope > .item-status-view, :scope > .priority-pill, :scope > .owner-cell"))
        .map((field) => ({ field: field.className, right: field.getBoundingClientRect().right, cardRight: card.right }))
        .filter((field) => field.right > field.cardRight + 1);
    }));
    expect(overflow, "title, workflow, priority, and owner must fit inside each phone queue card").toEqual([]);
  });
  await attachScreen(page, "Phone queue keeps workflow, priority, and owner inside each card");

  await test.step("Open the create form using the keyboard on a phone viewport", async () => {
    const trigger = page.getByRole("button", { name: "New work item" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("What needs attention?")).toBeVisible();
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press("Tab");
      await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
  });
  await attachScreen(page, "Phone viewport with keyboard-accessible create dialog");

  await test.step("Escape closes the dialog and restores keyboard focus", async () => {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New work item" })).toBeFocused();
  });

  await test.step("Open a work item and read its workflow on a small screen", async () => {
    const row = page.locator(".item-row").first();
    await row.click();
    await expect(page.getByRole("dialog").locator(".item-workflow-detail")).toBeVisible();
    await attachScreen(page, "Phone viewport with item journey");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(row).toBeFocused();
  });
});
