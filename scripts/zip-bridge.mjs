#!/usr/bin/env node
/**
 * Build dist/woodpresser-bridge.zip.
 *
 * The writer lives in src/util/zip.ts and is shared with `woodpresser init`,
 * which drops the same archive next to the plugin so a user can upload it
 * straight from wp-admin. Run `npm run build` first (the script travels with
 * the compiled output, not with the source).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bridgeZip } from "../dist/util/zip.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const source = join(root, "bridge", "woodpresser-bridge.php");
const outDir = join(root, "dist");
const target = join(outDir, "woodpresser-bridge.zip");

const plugin = readFileSync(source);
const zip = bridgeZip(plugin, statSync(source).mtime);

mkdirSync(outDir, { recursive: true });
writeFileSync(target, zip);
process.stdout.write(`${target} (${(zip.length / 1024).toFixed(1)} KiB)\n`);
