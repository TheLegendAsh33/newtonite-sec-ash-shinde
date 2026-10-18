import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { FullConfig } from "@playwright/test";

const repositoryRoot = resolve(__dirname, "../..");
const composeArgs = ["compose", "--project-name", "newtonite-e2e", "--file", "docker-compose.e2e.yml"];

function compose(args: string[]) {
  execFileSync("docker", [...composeArgs, ...args], {
    cwd: repositoryRoot,
    stdio: "inherit",
    timeout: 600_000,
    windowsHide: true,
  });
}

export default async function globalSetup(_config: FullConfig) {
  if (process.env.E2E_MANAGED_EXTERNALLY === "true") return;

  try {
    // This dedicated project owns only the disposable Playwright database and ports.
    compose(["down", "--volumes", "--remove-orphans"]);
    compose(["up", "--detach", "--build", "--wait", "--wait-timeout", "300"]);
  } catch (error) {
    try {
      compose(["down", "--volumes", "--remove-orphans"]);
    } catch {
      // Preserve the original startup error; teardown can also be run with `npm run e2e:down`.
    }
    throw error;
  }
}
