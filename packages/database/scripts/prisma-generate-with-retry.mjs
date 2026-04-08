import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runGenerate() {
  const prismaCliPath = path.resolve(
    process.cwd(),
    "node_modules",
    "prisma",
    "build",
    "index.js"
  );

  return spawnSync(
    process.execPath,
    [prismaCliPath, "generate", "--schema=./prisma/schema.prisma"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    }
  );
}

function printProcessResult(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function isEpermFailure(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /EPERM|operation not permitted/i.test(output);
}

let lastResult = null;

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  const result = runGenerate();
  lastResult = result;

  printProcessResult(result);

  if (result.status === 0) {
    process.exit(0);
  }

  if (!isEpermFailure(result) || attempt === MAX_ATTEMPTS) {
    break;
  }

  console.warn(
    `[prisma-generate] Attempt ${attempt}/${MAX_ATTEMPTS} failed with a Windows file lock (EPERM). Retrying in ${RETRY_DELAY_MS}ms...`
  );
  // eslint-disable-next-line no-await-in-loop
  await sleep(RETRY_DELAY_MS);
}

console.error(
  "[prisma-generate] Failed after retries. Close running Node/Next processes that may lock Prisma engine files, then run `pnpm db:generate` again."
);
process.exit(lastResult?.status ?? 1);
