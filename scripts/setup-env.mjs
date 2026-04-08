import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const templates = [
  {
    source: path.join(repoRoot, "apps", "web", ".env.example"),
    target: path.join(repoRoot, "apps", "web", ".env.local"),
  },
  {
    source: path.join(repoRoot, "packages", "database", ".env.example"),
    target: path.join(repoRoot, "packages", "database", ".env"),
  },
];

let createdCount = 0;

for (const { source, target } of templates) {
  if (!existsSync(source)) {
    throw new Error(`Template file is missing: ${path.relative(repoRoot, source)}`);
  }

  if (existsSync(target)) {
    console.log(`skip  ${path.relative(repoRoot, target)} (already exists)`);
    continue;
  }

  copyFileSync(source, target);
  createdCount += 1;
  console.log(`create ${path.relative(repoRoot, target)}`);
}

if (createdCount === 0) {
  console.log("No env files were created.");
} else {
  console.log(`Created ${createdCount} environment file(s).`);
}
