import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(appDir, ".next-dev.lock");
const nextCliPath = path.join(appDir, "node_modules", "next", "dist", "bin", "next");
const normalizedAppDir = path.normalize(appDir).toLowerCase();
const normalizedNextCliPath = path.normalize(nextCliPath).toLowerCase();
const nextCliMarker = path.normalize(path.join("next", "dist", "bin", "next")).toLowerCase();

function commandLineMatchesNextDev(commandLine) {
  if (typeof commandLine !== "string") {
    return false;
  }

  const normalizedCommandLine = commandLine.toLowerCase();
  return (
    normalizedCommandLine.includes(normalizedAppDir) &&
    (normalizedCommandLine.includes(normalizedNextCliPath) ||
      normalizedCommandLine.includes(nextCliMarker)) &&
    /\bdev\b/.test(normalizedCommandLine)
  );
}

function findExistingDevProcess() {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress",
      ],
      {
        encoding: "utf8",
      }
    );

    if (result.status !== 0 || !result.stdout.trim()) {
      return null;
    }

    const parsed = JSON.parse(result.stdout);
    const processes = Array.isArray(parsed) ? parsed : [parsed];

    return (
      processes.find(
        (entry) =>
          entry.ProcessId !== process.pid &&
          commandLineMatchesNextDev(entry.CommandLine)
      ) ?? null
    );
  }

  const result = spawnSync("ps", ["-eo", "pid=,command="], {
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout.trim()) {
    return null;
  }

  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    const commandLine = match[2];

    if (pid === process.pid || !commandLineMatchesNextDev(commandLine)) {
      continue;
    }

    return {
      ProcessId: pid,
      CommandLine: commandLine,
    };
  }

  return null;
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readLock() {
  try {
    const content = await fs.readFile(lockPath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeLock(payload) {
  await fs.writeFile(lockPath, JSON.stringify(payload, null, 2), { flag: "wx" });
}

async function removeLockIfOwned(token) {
  const currentLock = await readLock();
  if (!currentLock || currentLock.token !== token) {
    return;
  }

  await fs.unlink(lockPath).catch((error) => {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  });
}

async function acquireLock() {
  const existingProcess = findExistingDevProcess();
  if (existingProcess) {
    console.error(
      [
        `Another @provacx/web dev server is already running (pid ${existingProcess.ProcessId}).`,
        "Stop the existing process before starting a second one.",
        "Concurrent Next.js dev servers race on apps/web/.next and can trigger missing webpack.js and webpack cache rename errors.",
      ].join("\n")
    );
    process.exit(1);
  }

  const token = `${process.pid}:${Date.now()}`;
  const payload = {
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
    cwd: appDir,
    args: process.argv.slice(2),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeLock(payload);
      return token;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const existingLock = await readLock();
      if (existingLock && isProcessRunning(existingLock.pid)) {
        console.error(
          [
            `Another @provacx/web dev server is already running (pid ${existingLock.pid}).`,
            "Stop the existing process before starting a second one.",
            "Concurrent Next.js dev servers race on apps/web/.next and can trigger missing webpack.js and webpack cache rename errors.",
          ].join("\n")
        );
        process.exit(1);
      }

      await fs.unlink(lockPath).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") {
          throw unlinkError;
        }
      });
    }
  }

  throw new Error(`Could not acquire the dev lock at ${lockPath}`);
}

const lockToken = await acquireLock();
let cleaningUp = false;

async function cleanup() {
  if (cleaningUp) {
    return;
  }

  cleaningUp = true;
  await removeLockIfOwned(lockToken);
}

const child = spawn(process.execPath, [nextCliPath, "dev", ...process.argv.slice(2)], {
  cwd: appDir,
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on("error", async (error) => {
  console.error(error);
  await cleanup();
  process.exit(1);
});

child.on("exit", async (code, signal) => {
  await cleanup();

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
