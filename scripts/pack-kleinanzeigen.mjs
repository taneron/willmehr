#!/usr/bin/env node
/**
 * Stage the Kleinanzeigen server as its own npm package.
 *
 * Both servers build from one tsconfig, but they are published under two names:
 * the MCP registry resolves an entry's npm identifier to the binary of the same
 * name, so `kleinanzeigen-mcp` needs a package called `kleinanzeigen-mcp` to be
 * listed at all. This copies the built output the Kleinanzeigen entry point
 * actually reaches — its own directory plus the shared mode module — and
 * generates a manifest around it. Same version, same commit, released together.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "kleinanzeigen-mcp");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "dist"), { recursive: true });

await cp(join(root, "dist", "kleinanzeigen"), join(out, "dist", "kleinanzeigen"), { recursive: true });
// src/kleinanzeigen/index.ts imports ../mode.js at runtime; everything else it
// reaches lives under dist/kleinanzeigen.
for (const file of ["mode.js", "mode.d.ts", "mode.js.map"]) {
  await cp(join(root, "dist", file), join(out, "dist", file));
}
for (const file of ["LICENSE", "NOTICE"]) {
  await cp(join(root, file), join(out, file));
}
await cp(join(root, "packaging", "kleinanzeigen", "README.md"), join(out, "README.md"));

await writeFile(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "kleinanzeigen-mcp",
      version: pkg.version,
      description: "MCP server for searching Kleinanzeigen.de, Germany's largest classifieds site",
      mcpName: "io.github.taneron/kleinanzeigen",
      license: pkg.license,
      author: pkg.author,
      homepage: "https://github.com/taneron/willmehr#kleinanzeigen",
      repository: pkg.repository,
      bugs: pkg.bugs,
      keywords: ["mcp", "model-context-protocol", "kleinanzeigen", "classifieds", "claude"],
      type: "module",
      engines: pkg.engines,
      bin: { "kleinanzeigen-mcp": "dist/kleinanzeigen/index.js" },
      files: ["dist", "NOTICE"],
      dependencies: pkg.dependencies,
    },
    null,
    2,
  ) + "\n",
);

console.log(`Staged kleinanzeigen-mcp@${pkg.version} in ${out}`);
