// [codeg-extended] Does the upstream text this fork leans on still exist?
//
// Run after merging an upstream release and BEFORE the slow gate:
//   node scripts/extended-compat.mjs            # checks the working tree
//   node scripts/extended-compat.mjs --root <dir>   # checks another checkout
//
// A merge that applies cleanly says nothing about whether the code the fork calls
// into, or the markup its plugins style, is still there. The gate would catch most of
// it, 15-40 minutes later; this answers in a second and names the dependency that broke.
//
// Two kinds of dependency, both listed in `scripts/extended-compat.json`:
// - `host`: upstream source text (a regex over one file) that a plugin or the plugin
//   host depends on. Each carries the reason, so a failure says who is affected.
// - the selectors of every built-in CSS plugin are collected from the CSS itself, so a
//   new rule is covered without touching the list: each class and attribute name must
//   still occur somewhere under `src/`.

import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const rootFlag = process.argv.indexOf("--root")
const root =
  rootFlag > -1
    ? resolve(process.argv[rootFlag + 1])
    : resolve(dirname(fileURLToPath(import.meta.url)), "..")
const config = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "extended-compat.json"),
    "utf8"
  )
)

const failures = []
let checked = 0

function read(file) {
  const path = join(root, file)
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

// `git grep` over the tree rather than a directory walk: it is what a person would
// run, it skips node_modules and build output, and it needs no extra code.
function occursInSrc(token) {
  const run = spawnSync("git", ["grep", "-F", "-q", "-e", token, "--", "src"], {
    cwd: root,
  })
  return run.status === 0
}

for (const dep of config.host) {
  checked += 1
  const text = read(dep.file)
  if (text === null) {
    failures.push(`${dep.file}: file is gone. ${dep.why}`)
  } else if (!new RegExp(dep.pattern).test(text)) {
    failures.push(`${dep.file}: no match for /${dep.pattern}/. ${dep.why}`)
  }
}

// `.name` and `[name` / `[name=` in a stylesheet, minus comments and what the fork owns.
function selectorTokens(css) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const tokens = new Set()
  for (const match of bare.matchAll(/\.([A-Za-z_][\w-]*)/g))
    tokens.add(match[1])
  for (const match of bare.matchAll(/\[\s*([A-Za-z_][\w-]*)/g))
    tokens.add(match[1])
  return [...tokens].filter((token) => !config.ownSelectors.includes(token))
}

const pluginsDir = join(root, "src-tauri", "builtin-plugins")
if (existsSync(pluginsDir)) {
  for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })) {
    const stylesDir = join(pluginsDir, plugin.name, "styles")
    if (!plugin.isDirectory() || !existsSync(stylesDir)) continue
    for (const file of readdirSync(stylesDir).filter((name) =>
      name.endsWith(".css")
    )) {
      const css = readFileSync(join(stylesDir, file), "utf8")
      for (const token of selectorTokens(css)) {
        checked += 1
        if (!occursInSrc(token)) {
          failures.push(
            `${plugin.name}/styles/${file}: "${token}" no longer appears under src/`
          )
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(
    `Compat probe FAILED (${failures.length} of ${checked} dependencies):`
  )
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(
  `Compat probe passed: ${checked} dependencies on upstream text still hold.`
)
