import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ENGINE_PATH = "node_modules/.prisma/client/query_engine-windows.dll.node";
const CLIENT_INDEX_PATH = "node_modules/.prisma/client/index.js";

const hasGeneratedClient = () => existsSync(ENGINE_PATH) && existsSync(CLIENT_INDEX_PATH);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runGenerate = () =>
  spawnSync("npx", ["prisma", "generate"], {
    shell: true,
    encoding: "utf8",
  });

const maxAttempts = 5;

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = runGenerate();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === 0) {
    process.exit(0);
  }

  const stderr = String(result.stderr ?? "");
  const stdout = String(result.stdout ?? "");
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  const isEpermRename =
    combined.includes("eperm") &&
    combined.includes("operation not permitted") &&
    combined.includes("query_engine-windows.dll.node");

  const canContinue = isEpermRename && hasGeneratedClient();
  if (canContinue) {
    console.warn(
      "[prisma-generate-safe] Prisma generate hit a Windows file lock (EPERM), using existing generated client.",
    );
    process.exit(0);
  }

  if (attempt === maxAttempts) {
    process.exit(result.status ?? 1);
  }

  await sleep(1200 * attempt);
}
