// Plain-node tests for Encore.js. Run: node tests/encore.test.mjs
import { readFileSync } from "node:fs"
import { strict as assert } from "node:assert"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, "..", "Encore.js"), "utf8")
const E = {}
new Function("exports", src + `
;exports.slug = slug
;exports.quoteArg = quoteArg
;exports.launchCommand = launchCommand
;exports.buildScene = buildScene
;exports.buildRestorePlan = buildRestorePlan
;exports.sceneMeta = sceneMeta
`)(E)

function client(over) {
  return Object.assign({
    address: "0x1", mapped: true, hidden: false, pid: 100,
    class: "foot", initialClass: "foot", title: "~",
    workspace: { id: 1, name: "1" }, floating: false, pinned: false,
    at: [0, 0], size: [800, 600], monitor: 0, fullscreen: 0
  }, over)
}

// ---- slug
assert.equal(E.slug("Deep Work!", 40), "deep-work")
assert.equal(E.slug("   ", 40), "scene")
assert.equal(E.slug("café ☕ time", 40), "caf-time")

// ---- argv quoting
assert.equal(E.quoteArg("simple-arg"), "simple-arg")
assert.equal(E.quoteArg("has space"), "'has space'")
assert.equal(E.quoteArg("it's"), "'it'\\''s'")

// ---- launch command: argv joined, webapps rebuilt from class
assert.equal(
  E.launchCommand(client({ pid: 7 }), { "7": ["foot", "-T", "a b"] }),
  "foot -T 'a b'")
assert.equal(
  E.launchCommand(client({ class: "chrome-x.com__-Default", pid: 8 }), { "8": ["/opt/browser"] }),
  "omarchy-launch-webapp https://x.com")

// ---- buildScene: skips special workspaces, unmapped, and pid-less
const scene = E.buildScene("t", [
  client({ address: "0xa", pid: 1 }),
  client({ address: "0xb", pid: 2, workspace: { id: -99, name: "special" } }),
  client({ address: "0xc", pid: 3, mapped: false }),
  client({ address: "0xd", pid: 0 })
], { id: 1 }, { "1": ["foot"], "2": ["foot"], "3": ["foot"] })
assert.equal(scene.windows.length, 1)
assert.equal(E.sceneMeta(scene).workspaces, 1)

// ---- restore plan: exact adopt emits a move only when needed
const saved = {
  name: "t", activeWorkspace: 2,
  windows: [{
    class: "foot", initialClass: "foot", title: "~", cmd: "foot",
    workspace: 2, floating: false, at: [0, 0], size: [800, 600],
    monitor: 0, fullscreen: 0, pinned: false
  }]
}
let plan = E.buildRestorePlan(saved, [client({ workspace: { id: 2, name: "2" } })], {}, true, null)
assert.equal(plan.unresolved, 0)
assert.ok(!plan.script.includes("window.move"), "no move for a window already home")

plan = E.buildRestorePlan(saved, [client()], {}, true, null)
assert.ok(plan.script.includes('workspace = "2"'), "moves window to saved workspace")

// ---- missing window spawns once, then waits
plan = E.buildRestorePlan(saved, [], {}, true, null)
assert.equal(plan.spawnedNow.length, 1)
assert.ok(plan.script.includes("exec_cmd"))
plan = E.buildRestorePlan(saved, [], { 0: true }, false, null)
assert.equal(plan.spawnedNow.length, 0, "never spawns twice")
assert.equal(plan.unresolved, 1)

// ---- newborn adoption: wrong class still fills a spawned slot
plan = E.buildRestorePlan(saved,
  [client({ class: "renamed-app", initialClass: "renamed-app", address: "0xnew" })],
  { 0: true }, false, { "0xold": true })
assert.equal(plan.unresolved, 0, "newborn adopted despite class change")
assert.ok(plan.script.includes("0xnew"))

// ---- but an old window with the wrong class is never stolen
plan = E.buildRestorePlan(saved,
  [client({ class: "renamed-app", initialClass: "renamed-app", address: "0xold" })],
  { 0: true }, false, { "0xold": true })
assert.equal(plan.unresolved, 1, "pre-existing stranger left alone")

// ---- scratchpad retrieval: special-workspace window is adopted, not respawned
plan = E.buildRestorePlan(saved,
  [client({ workspace: { id: -98, name: "special:scratchpad" } })], {}, true, null)
assert.equal(plan.spawnedNow.length, 0, "no spawn when the window hides in scratchpad")
assert.ok(plan.script.includes('workspace = "2"'))

// ---- floating restore orders resize before move
const savedFloat = JSON.parse(JSON.stringify(saved))
savedFloat.windows[0].floating = true
savedFloat.windows[0].at = [100, 120]
plan = E.buildRestorePlan(savedFloat, [client({ workspace: { id: 2, name: "2" }, floating: true })], {}, true, null)
const resizeAt = plan.script.indexOf("window.resize")
const moveAt = plan.script.indexOf("x = 100")
assert.ok(resizeAt >= 0 && moveAt > resizeAt, "resize precedes position")

console.log("all tests passed")
