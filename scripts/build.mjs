import { mkdir, readdir, copyFile } from "node:fs/promises";

const source = new URL("../src/", import.meta.url);
const output = new URL("../dist/", import.meta.url);
await mkdir(output, { recursive: true });
for (const file of await readdir(source)) {
  if (file.endsWith(".js")) await copyFile(new URL(file, source), new URL(file, output));
}
await copyFile(new URL("../manifest.js", import.meta.url), new URL("manifest.js", output));
