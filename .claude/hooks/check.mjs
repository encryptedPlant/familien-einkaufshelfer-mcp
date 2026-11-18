// Claude Code Stop hook: runs the typecheck and Vitest before a turn may end.
//
// Exit 0  -> all checks passed (or the loop guard released a failing state,
//            which is reported to the user via `systemMessage`).
// Exit 2  -> a check failed or could not be started; stderr is fed back to
//            Claude so it keeps working on the cause.
//
// Only local tools are run (no network, no AI calls). The checks mirror the
// npm scripts `typecheck` and `test` in package.json; keep them in sync.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Consecutive blocked stops within one turn before the loop guard gives up. */
const MAX_BLOCKS = 3;
const CHECK_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_LINES = 40;

// The project root is derived from this file's location, never from the cwd.
const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const checks = [
  {
    name: "Typecheck",
    script: "npm run typecheck",
    pkg: "typescript",
    bin: "tsc",
    args: ["--noEmit"],
  },
  {
    name: "Vitest",
    script: "npm test",
    pkg: "vitest",
    bin: "vitest",
    args: ["run", "--passWithNoTests"],
  },
];

function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function stateFile(sessionId) {
  const key = createHash("sha256")
    .update(`${projectRoot}\0${sessionId}`)
    .digest("hex");
  return join(tmpdir(), "einkaufshelfer-stop-hook", `${key.slice(0, 32)}.json`);
}

function readBlocks(file) {
  try {
    const blocks = JSON.parse(readFileSync(file, "utf8")).blocks;
    return Number.isInteger(blocks) && blocks > 0 ? blocks : 0;
  } catch {
    return 0;
  }
}

function writeBlocks(file, blocks) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ blocks }));
    return true;
  } catch {
    return false;
  }
}

function clearBlocks(file) {
  try {
    rmSync(file, { force: true });
  } catch {
    // Best effort: a stale counter only shortens the next retry budget.
  }
}

/** Resolves a package's bin entry to an absolute JS file inside node_modules. */
function resolveBin(pkg, bin) {
  const pkgDir = join(projectRoot, "node_modules", pkg);
  const manifest = JSON.parse(
    readFileSync(join(pkgDir, "package.json"), "utf8"),
  );
  const rel =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
  if (!rel) throw new Error(`package "${pkg}" declares no "${bin}" executable`);
  const file = join(pkgDir, rel);
  if (!existsSync(file)) throw new Error(`executable not found: ${file}`);
  return file;
}

function tail(text, lines = OUTPUT_TAIL_LINES) {
  const all = text.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const kept = all.slice(-lines).join("\n");
  return all.length > lines
    ? `[... ${all.length - lines} earlier lines omitted]\n${kept}`
    : kept;
}

function runCheck(check) {
  let binFile;
  try {
    binFile = resolveBin(check.pkg, check.bin);
  } catch (error) {
    return {
      ok: false,
      summary: `could not be started: ${error.message}. Run "npm install" in ${projectRoot}.`,
    };
  }

  // No shell: the node binary is spawned directly with an argument array.
  const result = spawnSync(process.execPath, [binFile, ...check.args], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const output = tail(`${result.stdout ?? ""}${result.stderr ?? ""}`);

  if (result.error) {
    const reason =
      result.error.code === "ETIMEDOUT"
        ? `timed out after ${CHECK_TIMEOUT_MS / 1000} s`
        : `could not be started: ${result.error.message}`;
    return { ok: false, summary: reason, output };
  }
  if (result.signal) {
    return {
      ok: false,
      summary: `was terminated by signal ${result.signal}`,
      output,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      summary: `failed with exit code ${result.status}`,
      output,
    };
  }
  const noTests = check.pkg === "vitest" && /No test files found/i.test(output);
  return {
    ok: true,
    summary: noTests ? "passed: no test files found" : "passed",
    noTests,
  };
}

function report(results) {
  return results
    .map(({ check, result }) => {
      const head = `${result.ok ? "OK  " : "FAIL"} ${check.name} (${check.script}) ${result.summary}`;
      return !result.ok && result.output ? `${head}\n${result.output}` : head;
    })
    .join("\n\n");
}

function main() {
  const input = readHookInput();
  const file = stateFile(String(input.session_id ?? "manual"));
  // stop_hook_active is true when Claude is already continuing because this
  // hook blocked an earlier stop in the same turn; otherwise start counting anew.
  const continuing = input.stop_hook_active === true;
  const previousBlocks = continuing ? readBlocks(file) : 0;

  if (!existsSync(join(projectRoot, "package.json"))) {
    process.stderr.write(
      `Stop hook: no package.json found in ${projectRoot}; cannot run checks.\n`,
    );
    return 2;
  }

  const results = checks.map((check) => {
    try {
      return { check, result: runCheck(check) };
    } catch (error) {
      return {
        check,
        result: { ok: false, summary: `crashed: ${error?.message ?? error}` },
      };
    }
  });

  if (results.every(({ result }) => result.ok)) {
    clearBlocks(file);
    if (results.some(({ result }) => result.noTests)) {
      process.stdout.write(
        JSON.stringify({
          systemMessage:
            "Stop hook: typecheck passed; Vitest found no test files, so nothing was tested.",
        }),
      );
    }
    return 0;
  }

  const blocks = previousBlocks + 1;
  const failed = results
    .filter(({ result }) => !result.ok)
    .map(({ check }) => check.name);
  const persisted = blocks <= MAX_BLOCKS && writeBlocks(file, blocks);

  if (!persisted && (blocks > MAX_BLOCKS || continuing)) {
    // Loop guard: allow the turn to end, but say clearly that it is NOT green.
    clearBlocks(file);
    const why =
      blocks > MAX_BLOCKS
        ? `after ${MAX_BLOCKS} automatic fix attempts`
        : "and the retry counter could not be stored";
    const message =
      `Stop hook LOOP GUARD: checks are still failing ${why} (${failed.join(", ")}). ` +
      `Claude was allowed to finish anyway - the project is NOT green. ` +
      `Run "npm run typecheck" and "npm test" to see the errors.`;
    process.stdout.write(JSON.stringify({ systemMessage: message }));
    process.stderr.write(`${message}\n\n${report(results)}\n`);
    return 0;
  }

  process.stderr.write(
    `Stop hook: checks failed (blocked stop ${blocks} of ${MAX_BLOCKS}). ` +
      `Fix the cause before finishing; do not weaken or delete tests to get green.\n\n` +
      `${report(results)}\n`,
  );
  return 2;
}

let exitCode;
try {
  exitCode = main();
} catch (error) {
  process.stderr.write(
    `Stop hook crashed unexpectedly: ${error?.stack ?? error}\n`,
  );
  exitCode = 2;
}
process.exitCode = exitCode;
