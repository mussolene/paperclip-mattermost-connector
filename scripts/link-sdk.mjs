import { mkdir, readFile, realpath, lstat, symlink, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const supplied = process.argv[2];
if (!supplied || process.argv.length !== 3) throw new Error("Usage: npm run link-sdk -- /path/to/paperclip/packages/plugins/sdk");
const target = await realpath(resolve(supplied));
const sdk = JSON.parse(await readFile(resolve(target, "package.json"), "utf8"));
if (sdk.name !== "@paperclipai/plugin-sdk" || sdk.version !== "1.0.0") {
  throw new Error("Expected the built @paperclipai/plugin-sdk 1.0.0 from Paperclip 2026.1023.0");
}
await access(resolve(target, "dist/index.js"));
const link = resolve("node_modules/@paperclipai/plugin-sdk");
let existing;
try { existing = await lstat(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (existing) {
  if (!existing.isSymbolicLink() || await realpath(link) !== target) throw new Error("SDK destination already exists and was not changed");
} else {
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}
console.log("Paperclip host SDK linked and version checked");
