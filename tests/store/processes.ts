// Starting and synchronising worker processes for storage tests.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WorkerCommand } from "./worker";

export const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const TSX_LOADER = pathToFileURL(
  join(ROOT, "node_modules", "tsx", "dist", "loader.mjs"),
).href;
const WORKER = join(ROOT, "tests", "store", "worker.ts");

export type WorkerMessage = { event: string } & Record<string, unknown>;

export type Worker = {
  /** Resolves with the next message of this event; rejects if the process exits first. */
  next(event: string): Promise<WorkerMessage>;
  send(line: string): void;
  kill(): Promise<void>;
  readonly exited: Promise<number | null>;
  stderr(): string;
};

const running = new Set<ChildProcess>();

/** Runs a TypeScript file in a separate Node.js process with the tsx loader. */
export function spawnTs(
  file: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--import", TSX_LOADER, file, ...args],
    {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  running.add(child);
  child.on("exit", () => running.delete(child));
  return child;
}

export function startWorker(
  command: WorkerCommand,
  options: { cwd?: string; env?: Record<string, string> } = {},
): Worker {
  const child = spawnTs(WORKER, [JSON.stringify(command)], options);
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));

  const queue: WorkerMessage[] = [];
  const waiters: {
    event: string;
    resolve: (m: WorkerMessage) => void;
    reject: (e: Error) => void;
  }[] = [];
  let exitCode: number | null | undefined;

  const exited = new Promise<number | null>((resolveExit) => {
    child.on("exit", (code) => {
      exitCode = code;
      for (const w of waiters.splice(0)) {
        w.reject(
          new Error(
            `worker exited (${code}) before "${w.event}". stderr: ${stderr}`,
          ),
        );
      }
      resolveExit(code);
    });
  });

  createInterface({ input: child.stdout! }).on("line", (line) => {
    const message = JSON.parse(line) as WorkerMessage;
    if (message.event === "error") {
      // Surface the worker's own error instead of a bare exit code.
      for (const w of waiters.splice(0)) {
        w.reject(new Error(`worker error: ${String(message.message)}`));
      }
      return;
    }
    const index = waiters.findIndex((w) => w.event === message.event);
    if (index >= 0) waiters.splice(index, 1)[0]?.resolve(message);
    else queue.push(message);
  });

  return {
    next(event) {
      const index = queue.findIndex((m) => m.event === event);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]!);
      if (exitCode !== undefined) {
        return Promise.reject(
          new Error(`worker already exited before "${event}": ${stderr}`),
        );
      }
      return new Promise((res, rej) =>
        waiters.push({ event, resolve: res, reject: rej }),
      );
    },
    send(line) {
      child.stdin?.write(`${line}\n`);
    },
    async kill() {
      if (exitCode === undefined) {
        child.kill("SIGKILL");
        await exited;
      }
    },
    exited,
    stderr: () => stderr,
  };
}

/** Kills all still running child processes (call in afterEach). */
export async function killAllWorkers(): Promise<void> {
  await Promise.all(
    [...running].map(
      (child) =>
        new Promise<void>((res) => {
          child.once("exit", () => res());
          child.kill("SIGKILL");
        }),
    ),
  );
}

export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "einkaufshelfer-test-"));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}
