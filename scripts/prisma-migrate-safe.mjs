import { spawnSync } from "node:child_process";

const DEFAULT_DATABASE_URL = "file:dev.sqlite";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = DEFAULT_DATABASE_URL;
}

const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  shell: true,
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
