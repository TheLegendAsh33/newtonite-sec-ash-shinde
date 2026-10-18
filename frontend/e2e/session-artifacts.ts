import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

type RecordedSession = { context: BrowserContext; name: string };
const recordedSessions: RecordedSession[] = [];

const journeys: Record<string, string[]> = {
  "Sign-in": ["Four demo reviewers", "Separate sessions", "Load assigned teams", "Correct roles only"],
  "Work claiming": ["Two teammates", "Same unassigned item", "Claim simultaneously", "One owner; one conflict"],
  "Stale edits": ["Both read version 1", "First teammate saves", "Older save conflicts", "Latest update survives"],
  "Member permissions": ["Member opens item", "Read-only controls", "Try protected API", "403; item unchanged"],
  "Safe API retries": ["Shared request key", "Two create requests", "Compare item IDs", "One stored work item"],
  "Create form retries": ["Submit create form", "Capture request key", "Replay twice", "One stored work item"],
  "Visual queue": ["Select lifecycle step", "Filter list results", "Open the board", "Same filtered work"],
  "Item journey": ["Start work", "Block then resume", "Finish without review", "Show recorded visits"],
  "Small screens and keyboard": ["Phone viewport", "Keyboard opens dialog", "Tab stays inside", "Escape restores focus"],
};

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[character]!));
}

export async function attachScenarioJourney(): Promise<void> {
  const title = test.info().title.split(":")[0];
  const stages = journeys[title];
  if (!stages) return;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="230" viewBox="0 0 1280 230">
    <rect width="1280" height="230" rx="18" fill="#f5f8f6"/>
    <text x="32" y="40" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#142b22">${escapeXml(title)}</text>
    <text x="32" y="64" font-family="Arial, sans-serif" font-size="13" fill="#65756d">Chromium scenario · follow the named steps and screenshots in the report</text>
    ${stages.map((stage, index) => {
      const x = 32 + index * 310;
      return `${index < 3 ? `<path d="M ${x + 274} 143 h 26 l -5 -5 m 5 5 l -5 5" fill="none" stroke="#b1c6b9" stroke-width="2"/>` : ""}
        <rect x="${x}" y="98" width="274" height="90" rx="12" fill="${index === 3 ? "#e6f4ec" : "#fff"}" stroke="${index === 3 ? "#509574" : "#dce6df"}"/>
        <text x="${x + 18}" y="126" font-family="Arial, sans-serif" font-size="11" font-weight="700" letter-spacing="1" fill="#65756d">${index === 3 ? "EXPECTED RESULT" : `STEP ${index + 1}`}</text>
        <text x="${x + 18}" y="157" font-family="Arial, sans-serif" font-size="17" font-weight="600" fill="#183d2c">${escapeXml(stage)}</text>`;
    }).join("")}
  </svg>`;
  await test.info().attach("Scenario journey", { body: svg, contentType: "image/svg+xml" });
}

/**
 * Manual contexts are necessary for multi-user races. Record their videos
 * explicitly and start their traces after sign-in, so capture excludes credential
 * entry. Session state stays in memory; generated artifacts stay gitignored.
 */
export async function authenticatedSession(
  browser: Browser,
  account: { name: string; email: string; password: string },
): Promise<{ context: BrowserContext; page: Page }> {
  return test.step(`Sign in as ${account.name}`, async () => {
    const baseURL = String(test.info().project.use.baseURL);
    const loginContext = await browser.newContext({ baseURL });
    let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;
    let loginPage: Page | undefined;
    try {
      loginPage = await loginContext.newPage();
      await loginPage.goto("/");
      await loginPage.getByLabel("Email address").fill(account.email);
      await loginPage.getByLabel("Password").fill(account.password);
      await loginPage.getByRole("button", { name: "Sign in" }).click();
      await expect(loginPage.getByRole("button", { name: "New work item" })).toBeVisible();
      await expect(loginPage.getByText(account.name, { exact: true })).toBeVisible();
      // Keep credentials and session state in memory; never write storageState.
      storageState = await loginContext.storageState();
    } catch (error) {
      if (loginPage && !loginPage.isClosed()) {
        await test.info().attach(`Sign-in failed for ${account.name}`, {
          body: await loginPage.screenshot({ fullPage: true, animations: "disabled", mask: [loginPage.locator("input")] }),
          contentType: "image/png",
        });
      }
      throw error;
    } finally {
      await loginContext.close();
    }

    const name = `${recordedSessions.length + 1}-${account.name.toLowerCase().replace(/\s+/g, "-")}`;
    const context = await browser.newContext({
      baseURL,
      storageState,
      viewport: { width: 1440, height: 960 },
      recordVideo: { dir: test.info().outputPath("session-videos"), size: { width: 1440, height: 960 } },
    });
    recordedSessions.push({ context, name });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: account.name });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("button", { name: "New work item" })).toBeVisible();
    return { context, page };
  });
}

export async function finishSessionArtifacts(): Promise<void> {
  const failed = test.info().status !== test.info().expectedStatus;
  await Promise.all(recordedSessions.splice(0).map(async ({ context, name }) => {
    const pages = context.pages();
    if (failed) {
      for (const [index, page] of pages.entries()) {
        await test.info().attach(`${name}-page-${index + 1}-failure`, {
          body: await page.screenshot({ fullPage: await page.getByRole("dialog").count() === 0, animations: "disabled", mask: [page.locator('input[type="password"]')] }),
          contentType: "image/png",
        });
      }
      const path = test.info().outputPath(`${name}-trace.zip`);
      await context.tracing.stop({ path });
      await test.info().attach(`${name}-trace`, { path, contentType: "application/zip" });
    } else {
      await context.tracing.stop();
    }
    await context.close();
    for (const [index, page] of pages.entries()) {
      const video = page.video();
      if (!video) continue;
      if (failed) {
        await test.info().attach(`${name}-page-${index + 1}-video`, { path: await video.path(), contentType: "video/webm" });
      } else {
        await video.delete();
      }
    }
  }));
}
