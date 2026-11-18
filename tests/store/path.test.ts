import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { projectRoot, resolveStorePath } from "../../src/store/path";
import { killAllWorkers, ROOT, startWorker } from "./processes";

afterEach(async () => {
  await killAllWorkers();
});

async function pathFromProcess(
  cwd: string,
  env: Record<string, string> = {},
): Promise<string> {
  const worker = startWorker({ type: "path" }, { cwd, env });
  return String((await worker.next("path")).path);
}

describe("store path (SPEC §4.6)", () => {
  test("the project root is the directory with this project's package.json", () => {
    expect(projectRoot()).toBe(ROOT);
    const manifest = JSON.parse(
      readFileSync(join(projectRoot(), "package.json"), "utf8"),
    );
    expect(manifest.name).toBe("familien-einkaufshelfer-mcp");
  });

  test("defaults to <project root>/data/store.json", () => {
    expect(resolveStorePath({})).toBe(join(ROOT, "data", "store.json"));
  });

  test("an absolute EINKAUFSHELFER_DATA_FILE is used as is", () => {
    const file = join(tmpdir(), "einkaufshelfer-elsewhere", "store.json");
    expect(resolveStorePath({ EINKAUFSHELFER_DATA_FILE: file })).toBe(file);
  });

  test("an empty EINKAUFSHELFER_DATA_FILE falls back to the default", () => {
    expect(resolveStorePath({ EINKAUFSHELFER_DATA_FILE: "  " })).toBe(
      join(ROOT, "data", "store.json"),
    );
  });

  test("AC-ST4: processes with different working directories get the same absolute default path", async () => {
    const fromTemp = await pathFromProcess(tmpdir());
    const fromSrc = await pathFromProcess(join(ROOT, "src"));
    expect(fromTemp).toBe(join(ROOT, "data", "store.json"));
    expect(fromSrc).toBe(fromTemp);
    expect(isAbsolute(fromTemp)).toBe(true);
  }, 30_000);

  test("AC-ST4: a relative EINKAUFSHELFER_DATA_FILE is resolved against the project root, not the working directory", async () => {
    const env = { EINKAUFSHELFER_DATA_FILE: join("tmp-test", "store.json") };
    const fromTemp = await pathFromProcess(tmpdir(), env);
    const fromSrc = await pathFromProcess(join(ROOT, "src"), env);
    expect(fromTemp).toBe(resolve(ROOT, "tmp-test", "store.json"));
    expect(fromSrc).toBe(fromTemp);
    // Only computed, never created.
    expect(existsSync(join(ROOT, "tmp-test"))).toBe(false);
  }, 30_000);
});
