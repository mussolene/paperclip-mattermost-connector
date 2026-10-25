import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/link-sdk.mjs", import.meta.url));
test("SDK linking validates version, is repeatable, and preserves an occupied destination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-sdk-link-"));
  try {
    const sdk = join(dir, "sdk");
    await mkdir(join(sdk, "dist"), { recursive: true });
    await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@paperclipai/plugin-sdk", version: "1.0.0" }));
    await writeFile(join(sdk, "dist/index.js"), "export {};\n");
    execFileSync(process.execPath, [script, sdk], { cwd: dir });
    execFileSync(process.execPath, [script, sdk], { cwd: dir });
    assert.equal(await realpath(join(dir, "node_modules/@paperclipai/plugin-sdk")), await realpath(sdk));
    await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@paperclipai/plugin-sdk", version: "2.0.0" }));
    assert.throws(() => execFileSync(process.execPath, [script, sdk], { cwd: dir, stdio: "pipe" }), /Command failed/);
    await rm(join(dir, "node_modules"), { recursive: true });
    await mkdir(join(dir, "node_modules/@paperclipai/plugin-sdk"), { recursive: true });
    await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@paperclipai/plugin-sdk", version: "1.0.0" }));
    assert.throws(() => execFileSync(process.execPath, [script, sdk], { cwd: dir, stdio: "pipe" }), /Command failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
