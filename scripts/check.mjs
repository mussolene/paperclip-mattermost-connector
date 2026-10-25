import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import manifest from "../manifest.js";
import { validateConfig } from "../src/config.js";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.version !== manifest.version || manifest.apiVersion !== 1) throw new Error("Package and manifest versions do not match");
if (pkg.license !== "MIT" || !pkg.private) throw new Error("Expected MIT and private npm publication policy");
for (const dir of ["src", "scripts", "test"]) {
  for (const entry of await readdir(new URL(`../${dir}/`, import.meta.url))) {
    if (/\.(?:m?js)$/.test(entry)) execFileSync(process.execPath, ["--check", fileURLToPath(new URL(`../${dir}/${entry}`, import.meta.url))]);
  }
}
for (const file of ["manual.json", "managed.json"]) {
  validateConfig(JSON.parse(await readFile(new URL(`../examples/${file}`, import.meta.url), "utf8")));
}
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "SECURITY.md", "CONTRIBUTING.md"]) {
  if (!(await readFile(new URL(`../${file}`, import.meta.url), "utf8")).trim()) throw new Error(`Empty file: ${file}`);
}
console.log("Syntax, versions, example configurations and required documents: PASS");
