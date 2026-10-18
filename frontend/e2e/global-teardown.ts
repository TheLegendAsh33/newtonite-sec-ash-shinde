import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(__dirname, "../..");

export default async function globalTeardown() {
  if (process.env.E2E_MANAGED_EXTERNALLY === "true") return;

  try {
    execFileSync("docker", ["compose", "--project-name", "newtonite-e2e", "--file", "docker-compose.e2e.yml", "down", "--volumes", "--remove-orphans"], {
      cwd: repositoryRoot,
      stdio: "inherit",
      timeout: 120_000,
      windowsHide: true,
    });
  } catch {
    console.warn("Could not reach Docker during E2E teardown; run npm run e2e:down when the engine is available.");
  }
}
