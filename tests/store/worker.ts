// Child process for storage tests (run with the tsx loader, see processes.ts).
// Protocol: one JSON command as argv[2]; JSON lines on stdout; plain-text
// lines on stdin ("go", "release") for explicit synchronisation.

import { createInterface } from "node:readline";
import type { AddContext } from "../../src/core/add-to-list";
import { validateAddToShoppingListInput } from "../../src/core/validation";
import {
  acquireStoreLock,
  createJsonFileStore,
  type JsonFileStoreOptions,
} from "../../src/store/json-file-store";
import { addToShoppingListInStore } from "../../src/store/operations";
import { resolveStorePath } from "../../src/store/path";

export type WorkerCommand =
  | { readonly type: "path" }
  | {
      readonly type: "add";
      readonly storePath: string;
      readonly requests: readonly { requestId: string; items: unknown }[];
      readonly idPrefix: string;
      readonly now: string;
      readonly waitForGo: boolean;
      readonly options?: JsonFileStoreOptions;
    }
  | {
      readonly type: "hold-lock";
      readonly storePath: string;
      readonly options?: JsonFileStoreOptions;
    };

const command = JSON.parse(process.argv[2] ?? "{}") as WorkerCommand;
const stdinLines = createInterface({ input: process.stdin })[
  Symbol.asyncIterator
]();

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function waitForLine(expected: string): Promise<void> {
  for (;;) {
    const { value, done } = await stdinLines.next();
    if (done) throw new Error(`stdin closed before "${expected}"`);
    if (value.trim() === expected) return;
  }
}

/** Deterministic UUIDs: 8 hex digits of prefix + counter. */
function idGenerator(prefix: string): AddContext["newId"] {
  let n = 0;
  return () =>
    `${prefix.padEnd(8, "0")}-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

async function main(): Promise<void> {
  switch (command.type) {
    case "path":
      send({ event: "path", path: resolveStorePath() });
      return;

    case "add": {
      const store = createJsonFileStore(command.storePath, command.options);
      const context: AddContext = {
        now: command.now,
        newId: idGenerator(command.idPrefix),
      };
      send({ event: "ready" });
      if (command.waitForGo) await waitForLine("go");
      const results = [];
      for (const request of command.requests) {
        const input = validateAddToShoppingListInput(request);
        if (!input.ok) throw new Error(input.error.message);
        results.push(
          await addToShoppingListInStore(store, input.value, context),
        );
      }
      send({ event: "done", results });
      return;
    }

    case "hold-lock": {
      const lock = await acquireStoreLock(command.storePath, command.options);
      send({ event: "locked" });
      await waitForLine("release");
      const compromised = lock.isCompromised();
      await lock.release();
      send({ event: "released", compromised });
      return;
    }
  }
}

try {
  await main();
} catch (error) {
  send({ event: "error", message: String(error) });
  process.exitCode = 1;
} finally {
  process.stdin.destroy();
}
