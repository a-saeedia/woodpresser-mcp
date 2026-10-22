/**
 * Entry-point guard, imported before anything that needs a modern Node.
 *
 * ESM links named imports before any module body runs, so on an old runtime the
 * failure is a link error naming an export the user has never heard of. This
 * runs first and says the one thing that matters: upgrade Node.
 */
const version = process.versions.node;
const major = Number(version.split(".")[0]);

if (Number.isFinite(major) && major < 22) {
  process.stderr.write(
    [
      `woodpresser needs Node 22 or newer; this is v${version}.`,
      "  nvm:   nvm install 22 && nvm use 22",
      "  other: https://nodejs.org/en/download",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

export {};
