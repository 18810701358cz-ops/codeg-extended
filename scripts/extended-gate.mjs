// [codeg-extended] The checks CI runs, in the order CI would stop on them.
//
// Run this before pushing a feature branch: `node scripts/extended-gate.mjs`.
// CI is serial and halts at the first failing step, so without a local run each
// push surfaces one problem and costs a 10-30 minute round trip.
//
// Why each step exists:
// - `tsc` and `build`: vitest only transpiles, and a `vi.mock` factory can name
//   exports the real module does not have, so tests stay green while the
//   production build fails.
// - the line-ending check: an editor that writes CRLF turns every line of an
//   upstream file into a diff, and the next upstream merge conflicts file-wide.
// - the desktop test step: CI runs the desktop tests on Linux and macOS. On
//   Windows the test binary cannot start (0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND:
//   it links the Tauri runtime and lacks the manifest that needs), which is why
//   upstream CI only compiles it there and why this script does the same. A
//   Windows run therefore cannot see how the tests behave in desktop mode, so
//   they must not depend on machine state such as the OS keyring: the plugin
//   host reaches secrets only through `plugin_host::secrets`, which the tests
//   replace with an in-process map.
//
// Machine note: one `clippy-driver` on the codeg crate peaks around 7 GB, so the
// steps run serially and `-j` is capped. Point TEMP/TMP at a directory that
// survives restarts of the tool you run this from.
//
// Options: `--skip-rust` runs only the frontend steps, `--skip-frontend` only
// the Rust ones.

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tauriDir = resolve(root, "src-tauri")
const skipRust = process.argv.includes("--skip-rust")
const skipFrontend = process.argv.includes("--skip-frontend")
const windows = process.platform === "win32"

const frontend = [
  { name: "lint", cmd: "pnpm lint ." },
  { name: "tsc", cmd: "pnpm exec tsc --noEmit" },
  { name: "vitest", cmd: "pnpm test --maxWorkers=4" },
  { name: "build", cmd: "pnpm build" },
]

const rust = [
  {
    name: "clippy (desktop)",
    cmd: "cargo clippy -j 2 --all-targets --features test-utils -- -D warnings",
  },
  {
    name: "plugin_host tests (server)",
    cmd: "cargo test -j 2 --config profile.test.debug=0 --no-default-features --features server-bin --lib plugin_host",
  },
  {
    name: windows
      ? "plugin_host tests (desktop, compile only)"
      : "plugin_host tests (desktop)",
    cmd:
      "cargo test -j 1 --config profile.test.debug=0 --features test-utils --lib plugin_host" +
      (windows ? " --no-run" : ""),
  },
  {
    name: "clippy (server)",
    cmd: "cargo clippy --no-default-features --features server-bin --bin codeg-server --lib -- -D warnings",
  },
]

function lineEndings() {
  const run = spawnSync("git", ["ls-files", "--eol"], {
    cwd: root,
    encoding: "utf8",
  })
  if (run.status !== 0) {
    console.error(run.stderr)
    return false
  }
  const bad = run.stdout
    .split("\n")
    .filter((line) => /^i\/(crlf|mixed) /.test(line))
    .map((line) => line.split("\t")[1])
  if (bad.length > 0) {
    console.error("CRLF or mixed line endings in tracked files:")
    for (const file of bad) console.error(`  ${file}`)
    return false
  }
  return true
}

// The desktop build script wants the frontend export directory to exist; `pnpm
// build` writes the real one, this only covers a Rust-only run.
function ensureExportPlaceholder() {
  const index = resolve(root, "out/index.html")
  if (existsSync(index)) return
  mkdirSync(resolve(root, "out"), { recursive: true })
  writeFileSync(index, "<!doctype html><html><body></body></html>\n")
}

const results = []

function step(name, cwd, run) {
  console.log(`\n=== ${name} ===`)
  const started = Date.now()
  const ok = run()
  const seconds = Math.round((Date.now() - started) / 1000)
  results.push({ name, ok, seconds })
  if (!ok) {
    summary()
    console.error(`\nGate failed at: ${name}`)
    process.exit(1)
  }
}

function command(cmd, cwd) {
  return () =>
    spawnSync(cmd, { cwd, shell: true, stdio: "inherit" }).status === 0
}

function summary() {
  console.log("\n--- gate summary ---")
  for (const { name, ok, seconds } of results) {
    console.log(
      `${ok ? "pass" : "FAIL"}  ${String(seconds).padStart(4)}s  ${name}`
    )
  }
}

if (!skipFrontend) {
  for (const { name, cmd } of frontend) step(name, root, command(cmd, root))
}
step("line endings are LF", root, lineEndings)
if (!skipRust) {
  ensureExportPlaceholder()
  for (const { name, cmd } of rust) step(name, tauriDir, command(cmd, tauriDir))
}

summary()
console.log("\nGate passed.")
