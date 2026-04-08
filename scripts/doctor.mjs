import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const failures = [];
const warnings = [];

function readEnvFile(relativePath) {
  const filePath = path.join(repoRoot, relativePath);

  if (!existsSync(filePath)) {
    failures.push(`Missing file: ${relativePath}`);
    return {};
  }

  const content = readFileSync(filePath, "utf8");
  const env = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    env[key] = value;
  }

  return env;
}

function looksLikePlaceholder(value) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;

  return (
    normalized.includes("generate-a-random-secret") ||
    normalized.includes("same-as-") ||
    normalized.includes("your-") ||
    normalized.includes("example.com")
  );
}

function ensureNodeVersion() {
  const major = Number(process.versions.node.split(".")[0] ?? 0);
  if (major < 20) {
    failures.push(
      `Node.js ${process.versions.node} detected. Required: >=20.0.0`
    );
  }
}

function ensurePnpmVersion() {
  const ua = process.env.npm_config_user_agent ?? "";
  const match = ua.match(/pnpm\/(\d+)\./i);

  if (!match) {
    warnings.push("Could not detect pnpm version (run this via `pnpm setup:check`).");
    return;
  }

  const major = Number(match[1]);
  if (major < 10) {
    failures.push(`pnpm ${match[1]} detected. Required: >=10.`);
  }
}

function ensureWebEnv(env) {
  const baseUrl = env.AUTH_URL || env.NEXTAUTH_URL || "";
  const authSecret = env.AUTH_SECRET || env.NEXTAUTH_SECRET || "";

  if (!baseUrl) {
    failures.push("apps/web/.env.local is missing AUTH_URL or NEXTAUTH_URL.");
  } else if (looksLikePlaceholder(baseUrl)) {
    warnings.push(
      "apps/web/.env.local AUTH_URL/NEXTAUTH_URL looks like a placeholder."
    );
  }

  if (!authSecret) {
    failures.push(
      "apps/web/.env.local is missing AUTH_SECRET or NEXTAUTH_SECRET."
    );
  } else if (looksLikePlaceholder(authSecret)) {
    failures.push(
      "apps/web/.env.local AUTH_SECRET/NEXTAUTH_SECRET still looks like a placeholder."
    );
  }
}

function ensureDatabaseEnv(env) {
  const url = env.DATABASE_URL || "";

  if (!url) {
    failures.push("packages/database/.env is missing DATABASE_URL.");
    return;
  }

  if (!/^postgres(ql)?:\/\//i.test(url)) {
    failures.push("packages/database/.env DATABASE_URL must start with postgres:// or postgresql://.");
  }
}

ensureNodeVersion();
ensurePnpmVersion();

const webEnv = readEnvFile(path.join("apps", "web", ".env.local"));
const databaseEnv = readEnvFile(path.join("packages", "database", ".env"));

if (Object.keys(webEnv).length > 0) {
  ensureWebEnv(webEnv);
}
if (Object.keys(databaseEnv).length > 0) {
  ensureDatabaseEnv(databaseEnv);
}

if (warnings.length > 0) {
  console.warn("Warnings:");
  for (const warning of warnings) {
    console.warn(`- ${warning}`);
  }
}

if (failures.length > 0) {
  console.error("Doctor check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Doctor check passed.");
