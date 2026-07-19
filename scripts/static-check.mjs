import { readdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

async function filesUnder(relativePath) {
  const absolute = join(root, relativePath);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(relative));
    else if ([".js", ".mjs"].includes(extname(entry.name))) files.push(relative);
  }
  return files;
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const sourceFiles = [
  ...await filesUnder("js"),
  ...await filesUnder("test"),
  ...await filesUnder("scripts"),
];

for (const relativePath of sourceFiles) {
  const absolutePath = join(root, relativePath);
  const source = await readFile(absolutePath, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", absolutePath], { encoding: "utf8" });
  if (syntax.status !== 0) failures.push(`${relativePath}: ${syntax.stderr.trim()}`);
  if (!source.endsWith("\n")) failures.push(`${relativePath}: missing final newline`);
  source.split("\n").forEach((line, index) => {
    if (/[ \t]+$/.test(line)) failures.push(`${relativePath}:${index + 1}: trailing whitespace`);
    if (line.includes("\t")) failures.push(`${relativePath}:${index + 1}: tab character`);
  });

  const specifiers = source.matchAll(/\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g);
  for (const [, specifier] of specifiers) {
    if (!specifier.startsWith(".")) {
      if (relativePath.startsWith("js/")) {
        failures.push(`${relativePath}: production modules cannot import ${specifier}`);
      }
      continue;
    }
    if (!/\.(?:js|mjs)$/.test(specifier)) {
      failures.push(`${relativePath}: local import needs an extension: ${specifier}`);
      continue;
    }
    if (!await exists(resolve(dirname(absolutePath), specifier))) {
      failures.push(`${relativePath}: unresolved import: ${specifier}`);
    }
  }
}

for (const htmlFile of ["index.html", "preview.html"]) {
  const source = await readFile(join(root, htmlFile), "utf8");
  const references = source.matchAll(/\b(?:src|href)=["']([^"'#]+)["']/g);
  for (const [, reference] of references) {
    if (/^(?:https?:|mailto:|data:)/.test(reference)) continue;
    if (!await exists(resolve(root, reference))) {
      failures.push(`${htmlFile}: unresolved local reference: ${reference}`);
    }
  }
  const moduleImports = source.matchAll(/\bimport\s+[^"'`]*?\s+from\s+["']([^"']+)["']/g);
  for (const [, specifier] of moduleImports) {
    if (specifier.startsWith(".") && !await exists(resolve(root, specifier))) {
      failures.push(`${htmlFile}: unresolved inline module import: ${specifier}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Static checks passed for ${sourceFiles.length} JavaScript modules.`);
}
