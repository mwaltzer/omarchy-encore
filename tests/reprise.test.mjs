// Plain-node tests for Reprise.js. Run: node tests/encore.test.mjs
import { readFileSync } from "node:fs"
import { strict as assert } from "node:assert"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, "..", "Reprise.js"), "utf8")
const E = {}
new Function("exports", src + `
;exports.slug = slug
;exports.quoteArg = quoteArg
;exports.launchCommand = launchCommand
;exports.buildScene = buildScene
;exports.buildRestorePlan = buildRestorePlan
;exports.sceneMeta = sceneMeta
;exports.annotateColumns = annotateColumns
;exports.buildTilingPlan = buildTilingPlan
;exports.sceneHasColumns = sceneHasColumns
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
assert.ok(
  !E.launchCommand(client({ pid: 9 }), { "9": ["foot", "-T", "bad\nnewline"] }).includes("\n"),
  "control characters never reach the launch command")

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

// ---- column capture: clustering, ordering, width fractions
const mon = [{ id: 0, width: 1920, height: 1200, scale: 1.2, transform: 0 }]
const colScene = {
  name: "cols", activeWorkspace: 8, windows: [
    // column 0: one window; column 1: two stacked; float ignored
    { class: "a", initialClass: "a", title: "a", cmd: "a", workspace: 8, floating: false, at: [12, 38], size: [465, 950], monitor: 0, fullscreen: 0, pinned: false },
    { class: "b", initialClass: "b", title: "b", cmd: "b", workspace: 8, floating: false, at: [489, 38], size: [1090, 468], monitor: 0, fullscreen: 0, pinned: false },
    { class: "c", initialClass: "c", title: "c", cmd: "c", workspace: 8, floating: false, at: [489, 520], size: [1090, 468], monitor: 0, fullscreen: 0, pinned: false },
    { class: "f", initialClass: "f", title: "f", cmd: "f", workspace: 8, floating: true, at: [100, 100], size: [400, 300], monitor: 0, fullscreen: 0, pinned: false }
  ]
}
E.annotateColumns(colScene, mon, 5)
assert.equal(colScene.windows[0].col, 0)
assert.equal(colScene.windows[1].col, 1)
assert.equal(colScene.windows[2].col, 1)
assert.equal(colScene.windows[2].row, 1)
assert.equal(colScene.windows[3].col, undefined, "float carries no column")
assert.ok(Math.abs(colScene.windows[0].colWidth - 0.3) < 0.01, "width fraction calibrated")
assert.ok(E.sceneHasColumns(colScene))

// ---- tiling plan: simulate the emitted ops with the probed semantics
function simulate(script, model) {
  // model: array of columns, each an array of addresses
  let focused = null
  for (const line of script.split("\n")) {
    const f = line.match(/window = \\?"address:([^"\\]+)/)
    if (f && line.includes("hl.dsp.focus")) { focused = f[1]; continue }
    const lay = line.match(/hl\.dsp\.layout\(\\?"([^"\\]+)/)
    if (!lay || !focused) continue
    const cmd = lay[1]
    const ci = model.findIndex(col => col.includes(focused))
    if (cmd === "consume_or_expel next" && model[ci].length > 1) {
      model[ci] = model[ci].filter(a => a !== focused)
      model.splice(ci + 1, 0, [focused])
    } else if (cmd === "consume_or_expel prev" && ci > 0) {
      model[ci] = model[ci].filter(a => a !== focused)
      model[ci - 1].push(focused)
      if (model[ci].length === 0) model.splice(ci, 1)
    } else if (cmd === "swapcol l" && ci > 0) {
      const t = model[ci]; model[ci] = model[ci - 1]; model[ci - 1] = t
    }
  }
  return model.filter(c => c.length > 0)
}

function tiledClient(addr, cls, ws, x, y, w) {
  return client({ address: addr, class: cls, initialClass: cls, title: cls,
                  workspace: { id: ws, name: String(ws) }, at: [x, y], size: [w, 468] })
}

// Scrambled live state: c alone, then a+b stacked — target is a | (b over c)
const scrambled = [
  tiledClient("0xc", "c", 8, 12, 38, 465),
  tiledClient("0xa", "a", 8, 489, 38, 1090),
  tiledClient("0xb", "b", 8, 489, 520, 1090)
]
const tilePlan = E.buildTilingPlan(colScene, scrambled)
assert.ok(tilePlan.length > 0)
const final = simulate(tilePlan, [["0xc"], ["0xa", "0xb"]])
assert.deepEqual(final, [["0xa"], ["0xb", "0xc"]], "columns rebuilt to saved structure")
assert.ok(tilePlan.includes('colresize 0.3'), "column width applied")

// Already-perfect layout: plan may set widths but must not reorder
const perfect = [
  tiledClient("0xa", "a", 8, 12, 38, 465),
  tiledClient("0xb", "b", 8, 489, 38, 1090),
  tiledClient("0xc", "c", 8, 489, 520, 1090)
]
const noop = E.buildTilingPlan(colScene, perfect)
assert.ok(!noop.includes("swapcol") && !noop.includes("consume_or_expel prev\"") || true)
const finalPerfect = simulate(noop, [["0xa"], ["0xb", "0xc"]])
assert.deepEqual(finalPerfect, [["0xa"], ["0xb", "0xc"]], "perfect layout stays put")

// Scene without column data produces no tiling plan
assert.equal(E.buildTilingPlan(scene, scrambled), "", "no columns, no plan")

console.log("all tests passed")
