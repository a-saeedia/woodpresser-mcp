#!/usr/bin/env node
/**
 * Prove the published artifact actually works for a stranger.
 *
 * `npm test` runs the source tree. This packs the tarball, installs it into an
 * empty prefix with nothing but production dependencies, and drives the CLI the
 * way a new user would. Catches the class of bug where everything is green
 * locally but the package is missing a file, a shebang or a dist entry point.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "woodpresser-pack-"));

/** npm is a .cmd on Windows and Node refuses to execFile it directly. */
function npm(args) {
  const execPath = process.env.npm_execpath;
  if (execPath) return execFileSync(process.execPath, [execPath, ...args], { encoding: "utf8" });
  return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  const mark = condition ? "ok  " : "FAIL";
  console.log(`  ${mark} ${name}${detail && !condition ? ` -> ${detail}` : ""}`);
}

function toolCount(output) {
  return output.split(/\r?\n/).filter((line) => /^\s{2}wp_/.test(line)).length;
}

try {
  console.log(`packing ${pkg.name}@${pkg.version}`);
  const packed = JSON.parse(npm(["pack", "--pack-destination", tmp, "--json"]));
  const meta = packed[0];
  const tarball = join(tmp, meta.filename);
  const paths = meta.files.map((file) => file.path);

  console.log(`\ntarball ${meta.filename} (${(meta.size / 1024).toFixed(1)} kB unpacked, ${meta.unpackedSize ? (meta.unpackedSize / 1024).toFixed(1) + " kB" : "?"})`);
  check("tarball exists", existsSync(tarball));
  check("ships dist/cli.js", paths.includes("dist/cli.js"));
  check("ships dist/index.js", paths.includes("dist/index.js"));
  check("ships the bridge plugin", paths.includes("bridge/woodpresser-bridge.php"));
  check("ships README and LICENSE", paths.includes("README.md") && paths.includes("LICENSE"));
  check("no node_modules in the package", !paths.some((p) => p.startsWith("node_modules/")));
  check("no tests in the package", !paths.some((p) => p.startsWith("tests/")));
  check("no local config in the package", !paths.some((p) => p.includes(".woodpresser")));

  const app = join(tmp, "app");
  mkdirSync(app, { recursive: true });
  console.log(`\ninstalling into an empty prefix: ${app}`);
  npm(["install", "--prefix", app, "--no-audit", "--no-fund", tarball]);

  const installed = join(app, "node_modules", pkg.name);
  const cli = join(installed, "dist", "cli.js");
  check("installed cli.js exists", existsSync(cli));
  check(
    "installed bridge plugin matches the repo",
    existsSync(join(installed, "bridge", "woodpresser-bridge.php")) &&
      readFileSync(join(installed, "bridge", "woodpresser-bridge.php"), "utf8").length ===
        readFileSync("bridge/woodpresser-bridge.php", "utf8").length,
  );

  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" });

  const version = run("version");
  check("version reports the package version", version.includes(pkg.version), version.trim());

  const all = run("tools");
  check("tools lists all 39 tools offline", toolCount(all) === 39, `count=${toolCount(all)}`);

  const core = run("tools", "--modes", "core");
  check("core mode hides php tools", toolCount(core) === 19 && !core.includes("wp_php_run"), `count=${toolCount(core)}`);

  const php = run("tools", "--modes", "core,php");
  check("php mode exposes wp_php_run", php.includes("wp_php_run") && !php.includes("wp_el_build"));

  const el = run("tools", "--modes", "elementor");
  check("elementor mode exposes wp_el_build", el.includes("wp_el_build"));

  const help = run("--help");
  check(
    "help lists every command",
    ["init", "mcp", "doctor", "tools", "sites", "bridge", "install-mcp"].every((c) => help.includes(c)),
  );

  const sites = run("sites");
  check("sites runs with an empty config", sites.trim().length > 0);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
