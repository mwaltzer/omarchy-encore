// Pure helpers for capturing and restoring workspace scenes.
// No Qt imports — everything here is plain JavaScript, testable in node.

function slug(text, max) {
  var s = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
  s = s.replace(/^-+|-+$/g, "")
  if (s.length > max) s = s.slice(0, max).replace(/-+$/, "")
  return s || "scene"
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function matchKey(client) {
  return String(client["class"] || client.initialClass || "").toLowerCase()
}

// A client worth saving: a real, mapped window on a normal workspace,
// with a living process we can relaunch.
function capturable(c) {
  if (!c || !c.mapped || c.hidden) return false
  if (!c.workspace || c.workspace.id <= 0) return false
  if (!(c.pid > 0)) return false
  return matchKey(c).length > 0
}

// Quote one argv element for sh, only when it needs it — scenes are meant
// to be read and edited by hand.
function quoteArg(a) {
  a = String(a)
  if (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(a)) return a
  return shellQuote(a)
}

// Chromium web apps carry their URL in the window class
// ("chrome-x.com__-Default"); relaunching the bare browser binary would
// lose the app window, so rebuild the Omarchy-native launch instead.
function launchCommand(c, cmdByPid) {
  var m = String(c["class"] || "").match(/^chrome-(.+?)-Default$/)
  if (m) {
    var host = m[1].replace(/_+$/, "").replace(/_/g, "/")
    if (host.length > 0) return "omarchy-launch-webapp https://" + host
  }
  var argv = cmdByPid[String(c.pid)]
  if (!argv) return ""
  if (typeof argv === "string") return argv.trim()
  var parts = []
  for (var i = 0; i < argv.length; i++) parts.push(quoteArg(argv[i]))
  return parts.join(" ").trim()
}

// Build a scene from `hyprctl -j clients`, `hyprctl -j activeworkspace`,
// and a {pid: commandline} map read from /proc.
function buildScene(name, clients, activeWorkspace, cmdByPid) {
  var windows = []
  for (var i = 0; i < (clients || []).length; i++) {
    var c = clients[i]
    if (!capturable(c)) continue
    var cmd = launchCommand(c, cmdByPid)
    if (cmd.length === 0) continue
    windows.push({
      "class": String(c["class"] || ""),
      initialClass: String(c.initialClass || ""),
      title: String(c.title || ""),
      cmd: cmd,
      workspace: c.workspace.id,
      floating: c.floating === true,
      at: [c.at[0], c.at[1]],
      size: [c.size[0], c.size[1]],
      monitor: c.monitor,
      fullscreen: Number(c.fullscreen) || 0,
      pinned: c.pinned === true
    })
  }
  windows.sort(function(a, b) { return a.workspace - b.workspace })
  return {
    name: String(name || "").trim(),
    savedAt: "",
    activeWorkspace: activeWorkspace && activeWorkspace.id > 0 ? activeWorkspace.id : 1,
    windows: windows
  }
}

function sceneMeta(scene) {
  var ws = {}
  var wins = (scene && scene.windows) || []
  for (var i = 0; i < wins.length; i++) ws[wins[i].workspace] = true
  return { windows: wins.length, workspaces: Object.keys(ws).length }
}

// This Hyprland build uses the Lua config provider: `hyprctl dispatch`
// evaluates its argument as Lua, so plans are emitted as hl.dsp calls.
function luaQuote(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

function dispatchLine(lua) {
  return "hyprctl dispatch " + shellQuote(lua) + " >/dev/null"
}

// Emit the dispatch lines that shape one adopted window into its slot.
function adoptLines(w, cur, lines) {
  var win = '{ window = "address:' + cur.address + '"'
  if (cur.workspace.id !== w.workspace)
    lines.push(dispatchLine("hl.dsp.window.move(" + win + ', workspace = "' + w.workspace + '", follow = false })'))
  if (w.floating !== (cur.floating === true))
    lines.push(dispatchLine("hl.dsp.window.float(" + win + ', action = "toggle" })'))
  if (w.floating) {
    // Resize first: it can recenter the window, so position goes last.
    lines.push(dispatchLine("hl.dsp.window.resize(" + win + ", x = " + w.size[0] + ", y = " + w.size[1] + " })"))
    lines.push(dispatchLine("hl.dsp.window.move(" + win + ", x = " + w.at[0] + ", y = " + w.at[1] + " })"))
  }
  // Fullscreen and pin toggle, so only push toward the saved state.
  var wantFs = Number(w.fullscreen) || 0
  var haveFs = Number(cur.fullscreen) || 0
  if (wantFs > 0 && haveFs === 0)
    lines.push(dispatchLine("hl.dsp.window.fullscreen(" + win
      + ', mode = "' + (wantFs === 1 ? "maximized" : "fullscreen") + '" })'))
  else if (wantFs === 0 && haveFs > 0)
    lines.push(dispatchLine("hl.dsp.window.fullscreen(" + win
      + ', mode = "' + (haveFs === 1 ? "maximized" : "fullscreen") + '" })'))
  if (w.pinned === true && cur.pinned !== true)
    lines.push(dispatchLine("hl.dsp.window.pin(" + win + " })"))
}

// Plan one adoption pass of a restore. Adopt existing windows into their
// saved slots (matched by class, saved title preferred); launch the
// commands for slots with no window yet — spawned windows are adopted on
// a later pass, once they have mapped. `spawnedSlots` marks slot indexes
// whose command was already launched on an earlier pass, so a slow app is
// never launched twice. `baselineAddrs` holds the addresses that existed
// before the restore began: a window not in it is a newborn, and a
// newborn may fill a spawned slot even when its class does not match what
// was saved (apps do not always come back under the class they had).
// Returns { script, spawnedNow, unresolved }.
function buildRestorePlan(scene, currentClients, spawnedSlots, firstPass, baselineAddrs) {
  var lines = []
  var pool = []
  var i, j
  for (i = 0; i < (currentClients || []).length; i++) {
    var c = currentClients[i]
    if (!c || !c.mapped || c.hidden) continue
    // Windows parked on special workspaces (scratchpad) stay adoptable:
    // a scene that owns one retrieves it instead of spawning a twin.
    if (!c.workspace) continue
    if (matchKey(c).length === 0) continue
    pool.push({ client: c, used: false,
                newborn: !!baselineAddrs && !baselineAddrs[c.address] })
  }

  if (firstPass)
    lines.push(dispatchLine('hl.dsp.focus({ workspace = "' + (scene.activeWorkspace || 1) + '" })'))

  var wins = (scene && scene.windows) || []
  var assigned = {}

  // Exact matches first: class, saved title preferred.
  for (i = 0; i < wins.length; i++) {
    var key = String(wins[i]["class"] || wins[i].initialClass || "").toLowerCase()
    var found = null
    for (j = 0; j < pool.length; j++) {
      if (pool[j].used) continue
      if (matchKey(pool[j].client) !== key) continue
      found = pool[j]
      if (String(pool[j].client.title || "") === wins[i].title) break
    }
    if (found) {
      found.used = true
      assigned[i] = found.client
    }
  }

  // Newborns fill the spawned slots that exact matching left empty.
  for (i = 0; i < wins.length; i++) {
    if (assigned[i] !== undefined || !spawnedSlots[i]) continue
    for (j = 0; j < pool.length; j++) {
      if (pool[j].used || !pool[j].newborn) continue
      pool[j].used = true
      assigned[i] = pool[j].client
      break
    }
  }

  var spawnedNow = []
  var unresolved = 0
  for (i = 0; i < wins.length; i++) {
    if (assigned[i] !== undefined) {
      adoptLines(wins[i], assigned[i], lines)
    } else if (!spawnedSlots[i]) {
      lines.push(dispatchLine("hl.dsp.exec_cmd(" + luaQuote(wins[i].cmd) + ")"))
      spawnedNow.push(i)
      unresolved++
    } else {
      unresolved++
    }
  }

  return { script: lines.join("\n"), spawnedNow: spawnedNow, unresolved: unresolved }
}
