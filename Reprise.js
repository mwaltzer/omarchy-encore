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
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a)) return a
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
  var entry = cmdByPid[String(c.pid)]
  if (!entry || !entry.argv || entry.argv.length === 0) return ""
  // Control characters would break the Lua string the command is later
  // embedded in; no launchable command legitimately contains them.
  var parts = []
  for (var i = 0; i < entry.argv.length; i++)
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
    parts.push(quoteArg(String(entry.argv[i]).replace(/[\x00-\x1f]+/g, " ")))
  return parts.join(" ").trim()
}

// The working directory recorded at save time, if any.
function capturedCwd(c, cmdByPid) {
  var entry = cmdByPid[String(c.pid)]
  if (!entry || !entry.cwd) return ""
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  return String(entry.cwd).replace(/[\x00-\x1f]+/g, "").trim()
}

// ---------------------------------------------------------------- columns

function logicalMonitorWidth(m) {
  if (!m) return 0
  var w = (Number(m.transform) % 2) ? m.height : m.width
  var s = Number(m.scale) > 0 ? Number(m.scale) : 1
  return w / s
}

// Cluster one workspace's tiled windows into scrolling-layout columns:
// same x edge (within tolerance) means same column; order columns by x
// and windows within a column by y.
function deriveColumns(wins) {
  var cols = []
  for (var i = 0; i < wins.length; i++) {
    var w = wins[i]
    var col = null
    for (var j = 0; j < cols.length; j++) {
      if (Math.abs(cols[j].x - w.at[0]) <= 8) { col = cols[j]; break }
    }
    if (!col) { col = { x: w.at[0], wins: [] }; cols.push(col) }
    col.wins.push(w)
  }
  cols.sort(function(a, b) { return a.x - b.x })
  for (var c = 0; c < cols.length; c++) {
    cols[c].wins.sort(function(a, b) { return a.at[1] - b.at[1] })
  }
  return cols
}

// Annotate a scene's tiled windows with their scrolling-layout position:
// column index, row within the column, and the column's width as a
// fraction of the monitor (calibrated against colresize's gap handling).
function annotateColumns(scene, monitors, gapsIn) {
  var byWs = {}
  var wins = (scene && scene.windows) || []
  var i
  for (i = 0; i < wins.length; i++) {
    var w = wins[i]
    if (w.floating || (Number(w.fullscreen) || 0) > 0) continue
    if (!byWs[w.workspace]) byWs[w.workspace] = []
    byWs[w.workspace].push(w)
  }
  var monById = {}
  for (i = 0; i < (monitors || []).length; i++) monById[monitors[i].id] = monitors[i]
  for (var ws in byWs) {
    var cols = deriveColumns(byWs[ws])
    for (var c = 0; c < cols.length; c++) {
      for (var r = 0; r < cols[c].wins.length; r++) {
        var win = cols[c].wins[r]
        win.col = c
        win.row = r
        var lw = logicalMonitorWidth(monById[win.monitor])
        if (lw > 0)
          win.colWidth = Math.round((win.size[0] + 3 * (gapsIn || 0)) / lw * 1000) / 1000
      }
    }
  }
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
    var cwd = capturedCwd(c, cmdByPid)
    windows.push({
      cwd: cwd,
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
    // oxlint-disable-next-line no-control-regex -- bounding display input
    name: String(name || "").replace(/[\x00-\x1f]+/g, " ").trim().slice(0, 120),
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
      var launch = wins[i].cmd
      // Bring terminals and friends back in the directory they lived in.
      if (wins[i].cwd) launch = "cd " + shellQuote(wins[i].cwd) + " && " + launch
      lines.push(dispatchLine("hl.dsp.exec_cmd(" + luaQuote(launch) + ")"))
      spawnedNow.push(i)
      unresolved++
    } else {
      unresolved++
    }
  }

  return { script: lines.join("\n"), spawnedNow: spawnedNow, unresolved: unresolved }
}

// ------------------------------------------------------------ tiling pass

function sceneHasColumns(scene) {
  var wins = (scene && scene.windows) || []
  for (var i = 0; i < wins.length; i++) {
    if (Number.isFinite(wins[i].col)) return true
  }
  return false
}

// Reproduce exact scrolling-layout columns after every window is in its
// workspace. Verified operation semantics on Hyprland's scrolling layout:
//   consume_or_expel next on a stacked window -> its own column, inserted
//     immediately after its current column (order preserved);
//   consume_or_expel prev -> append to the bottom of the previous column;
//   swapcol l -> swap the focused column with its left neighbour;
//   colresize <fraction> -> exact column width.
// The plan is computed against a simulated column model, so it runs open
// loop: focus a window, apply one operation, brief settle, repeat.
function buildTilingPlan(scene, currentClients) {
  var lines = []

  function op(addr, layoutCmd) {
    lines.push(dispatchLine('hl.dsp.focus({ window = "address:' + addr + '" })'))
    lines.push("sleep 0.1")
    lines.push(dispatchLine('hl.dsp.layout("' + layoutCmd + '")'))
    lines.push("sleep 0.1")
  }

  var byWs = {}
  var wins = (scene && scene.windows) || []
  var i, j
  for (i = 0; i < wins.length; i++) {
    var w = wins[i]
    if (w.floating || (Number(w.fullscreen) || 0) > 0) continue
    if (!Number.isFinite(w.col)) continue
    if (!byWs[w.workspace]) byWs[w.workspace] = []
    byWs[w.workspace].push(w)
  }

  for (var ws in byWs) {
    var slots = byWs[ws]

    // Current tiled windows of this workspace.
    var cur = []
    for (i = 0; i < (currentClients || []).length; i++) {
      var c = currentClients[i]
      if (!c || !c.mapped || c.hidden) continue
      if (!c.workspace || String(c.workspace.id) !== String(ws)) continue
      if (c.floating === true || (Number(c.fullscreen) || 0) > 0) continue
      cur.push(c)
    }

    // Slot -> window: exact class+title, then class, then leftovers in order.
    var used = {}
    var assign = {}
    for (i = 0; i < slots.length; i++) {
      for (j = 0; j < cur.length; j++) {
        if (used[j]) continue
        if (matchKey(cur[j]) !== String(slots[i]["class"] || "").toLowerCase()) continue
        if (String(cur[j].title || "") !== slots[i].title) continue
        assign[i] = cur[j].address; used[j] = true; break
      }
    }
    for (i = 0; i < slots.length; i++) {
      if (assign[i] !== undefined) continue
      for (j = 0; j < cur.length; j++) {
        if (used[j]) continue
        if (matchKey(cur[j]) !== String(slots[i]["class"] || "").toLowerCase()) continue
        assign[i] = cur[j].address; used[j] = true; break
      }
    }
    for (i = 0; i < slots.length; i++) {
      if (assign[i] !== undefined) continue
      for (j = 0; j < cur.length; j++) {
        if (used[j]) continue
        assign[i] = cur[j].address; used[j] = true; break
      }
    }

    // Target columns from the placed slots only.
    var colMap = {}
    for (i = 0; i < slots.length; i++) {
      if (assign[i] === undefined) continue
      if (!colMap[slots[i].col]) colMap[slots[i].col] = []
      colMap[slots[i].col].push(slots[i])
    }
    var targetCols = Object.keys(colMap).map(Number).sort(function(a, b) { return a - b })
      .map(function(ci) {
        var arr = colMap[ci].slice().sort(function(a, b) { return a.row - b.row })
        return {
          width: Number(arr[0].colWidth) || 0,
          addrs: arr.map(function(s) { return assign[slots.indexOf(s)] })
        }
      })
    if (targetCols.length === 0) continue

    // Simulated model of the live columns.
    var model = deriveColumns(cur.map(function(cc) {
      return { at: cc.at, size: cc.size, addr: cc.address }
    })).map(function(col) {
      return col.wins.map(function(ww) { return ww.addr })
    })

    // 1) Normalize: expel bottom windows until every column is a singleton.
    for (i = 0; i < model.length; i++) {
      while (model[i].length > 1) {
        var bottom = model[i][model[i].length - 1]
        op(bottom, "consume_or_expel next")
        model[i].pop()
        model.splice(i + 1, 0, [bottom])
      }
    }
    var order = model.map(function(col) { return col[0] })

    // 2) Selection-sort columns into flattened target order via swapcol l.
    var flat = []
    for (i = 0; i < targetCols.length; i++) flat = flat.concat(targetCols[i].addrs)
    for (var p = 0; p < flat.length; p++) {
      var at = order.indexOf(flat[p])
      if (at < 0) continue
      while (at > p) {
        op(flat[p], "swapcol l")
        order.splice(at, 1)
        order.splice(at - 1, 0, flat[p])
        at--
      }
    }

    // 3) Stack: members after the first join the column to their left.
    for (i = 0; i < targetCols.length; i++) {
      for (j = 1; j < targetCols[i].addrs.length; j++) {
        op(targetCols[i].addrs[j], "consume_or_expel prev")
      }
    }

    // 4) Widths.
    for (i = 0; i < targetCols.length; i++) {
      if (!(targetCols[i].width > 0)) continue
      lines.push(dispatchLine('hl.dsp.focus({ window = "address:' + targetCols[i].addrs[0] + '" })'))
      lines.push("sleep 0.1")
      lines.push(dispatchLine('hl.dsp.layout("colresize ' + targetCols[i].width + '")'))
      lines.push("sleep 0.1")
    }
  }

  if (lines.length > 0)
    lines.push(dispatchLine('hl.dsp.focus({ workspace = "' + (scene.activeWorkspace || 1) + '" })'))
  return lines.join("\n")
}
