import Quickshell
import Quickshell.Io
import QtQuick
import qs.Commons
import "Reprise.js" as Reprise

// Reprise service: captures the current window layout as a named scene and
// restores scenes by adopting existing windows and launching missing ones.
Item {
  id: root

  // Injected by omarchy-shell.
  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null
  property var barWidgetRegistry: null
  property var pluginRegistry: null

  readonly property string home: Quickshell.env("HOME")
  readonly property string scenesDir: home + "/.config/omarchy/reprise/scenes"

  // Bumped on every model change; consumers re-read scenes.
  property int revision: 0
  // Parsed scene objects, sorted by name: {name, file, savedAt, windows,
  // workspaces, scene}.
  property var scenes: []
  // "", "saving", "restoring" — the overlay shows a quiet phase hint.
  property string phase: ""
  property string lastError: ""

  // One in-flight operation at a time: {op: "save"|"restore", name, scene}.
  property var pending: null

  function bump() { revision++ }

  Component.onCompleted: mkdirProc.running = true

  Process {
    id: mkdirProc
    command: ["mkdir", "-p", root.scenesDir]
    onExited: root.scanScenes()
  }

  // -------------------------------------------------------------- listing

  function scanScenes() {
    if (lsProc.running) return
    lsProc.running = true
  }

  Process {
    id: lsProc
    command: ["sh", "-c",
              'for f in "$1"/*.json; do [ -e "$f" ] || continue; printf "%s\\t%s\\n" "$f" "$(base64 -w0 "$f")"; done',
              "sh", root.scenesDir]
    stdout: StdioCollector {
      id: lsStdout
      waitForEnd: true
      onStreamFinished: {
        var next = []
        var lines = String(lsStdout.text || "").split("\n")
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i]
          if (line.length === 0) continue
          var tab = line.indexOf("\t")
          if (tab === -1) continue
          var file = line.slice(0, tab)
          try {
            var scene = JSON.parse(String(Util.decodeBase64(line.slice(tab + 1)) || ""))
            if (!scene || !scene.name) continue
            var meta = Reprise.sceneMeta(scene)
            next.push({
              name: scene.name,
              file: file,
              savedAt: scene.savedAt || "",
              windows: meta.windows,
              workspaces: meta.workspaces,
              scene: scene
            })
          } catch (e) {}
        }
        next.sort(function(a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0) })
        root.scenes = next
        root.bump()
      }
    }
  }

  function sceneByName(name) {
    for (var i = 0; i < scenes.length; i++) {
      if (scenes[i].name === name) return scenes[i]
    }
    return null
  }

  // ------------------------------------------------------------ operations

  function saveScene(name) {
    var clean = String(name || "").trim()
    if (clean.length === 0) return { ok: false, error: "a scene needs a name" }
    if (root.pending) return { ok: false, error: "busy - try again in a moment" }
    root.pending = { op: "save", name: clean }
    root.phase = "saving"
    root.lastError = ""
    snapProc.running = true
    return { ok: true }
  }

  function restoreScene(name) {
    var entry = sceneByName(String(name || "").trim())
    if (!entry) return { ok: false, error: "unknown scene" }
    if (root.pending) return { ok: false, error: "busy - try again in a moment" }
    root.pending = { op: "restore", name: entry.name, scene: entry.scene,
                     pass: 0, spawnedSlots: {}, unresolved: 0, baseline: null }
    root.phase = "restoring"
    root.lastError = ""
    snapProc.running = true
    return { ok: true }
  }

  function deleteScene(name) {
    var entry = sceneByName(String(name || "").trim())
    if (!entry) return false
    rmProc.command = ["rm", "-f", entry.file]
    rmProc.running = true
    return true
  }

  Process {
    id: rmProc
    command: []
    onExited: root.scanScenes()
  }

  // Snapshot the live window state. Both save and restore start here.
  Process {
    id: snapProc
    command: ["sh", "-c",
      "hyprctl -j clients; echo __ENCORE__; hyprctl -j activeworkspace; echo __ENCORE__; " +
      "hyprctl -j monitors; echo __ENCORE__; hyprctl -j getoption general:layout; " +
      "echo __ENCORE__; hyprctl -j getoption general:gaps_in"]
    stdout: StdioCollector {
      id: snapStdout
      waitForEnd: true
      onStreamFinished: {
        var parts = String(snapStdout.text || "").split("__ENCORE__")
        var clients = []
        var active = null
        try { clients = JSON.parse(parts[0] || "[]") } catch (e) {}
        try { active = JSON.parse(parts[1] || "null") } catch (e2) {}
        try { root.snapMonitors = JSON.parse(parts[2] || "[]") } catch (e3) {}
        try { root.snapLayout = String(JSON.parse(parts[3] || "{}").str || "") } catch (e4) {}
        try {
          var g = JSON.parse(parts[4] || "{}")
          var first = String(g.css || g.int || "0").match(/\d+/)
          root.snapGapsIn = first ? parseInt(first[0], 10) : 0
        } catch (e5) {}
        root.onSnapshot(clients, active)
      }
    }
  }

  property var snapClients: []
  property var snapActive: null
  property var snapMonitors: []
  property string snapLayout: ""
  property int snapGapsIn: 0

  function onSnapshot(clients, active) {
    if (!root.pending) return
    root.snapClients = clients
    root.snapActive = active

    if (root.pending.op === "restore") {
      if (root.pending.stage === "tile") {
        var tileScript = Reprise.buildTilingPlan(root.pending.scene, clients)
        if (tileScript.length > 0) {
          runProc.command = ["sh", "-c", tileScript]
          runProc.running = true
        } else {
          root.finishRestore()
        }
        return
      }
      if (root.pending.baseline === null) {
        var base = {}
        for (var b = 0; b < clients.length; b++) base[clients[b].address] = true
        root.pending.baseline = base
      }
      var plan = Reprise.buildRestorePlan(root.pending.scene, clients,
                                         root.pending.spawnedSlots,
                                         root.pending.pass === 0,
                                         root.pending.baseline)
      for (var s = 0; s < plan.spawnedNow.length; s++)
        root.pending.spawnedSlots[plan.spawnedNow[s]] = true
      root.pending.pass++
      root.pending.unresolved = plan.unresolved
      if (plan.script.length > 0) {
        runProc.command = ["sh", "-c", plan.script]
        runProc.running = true
      } else if (root.pending.unresolved > 0 && root.pending.pass < 5) {
        settleTimer.restart()
      } else {
        root.maybeTile()
      }
      return
    }

    // Saving: fetch each window's launch command from /proc.
    var pids = []
    for (var i = 0; i < clients.length; i++) {
      if (clients[i] && clients[i].pid > 0) pids.push(clients[i].pid)
    }
    if (pids.length === 0) {
      root.finishOp("nothing on stage to save")
      return
    }
    // argv boundaries matter: an argument with spaces must survive the
    // round trip, so ship each cmdline as a JSON array, not a joined string.
    // The working directory comes from the window process — or, when that
    // reads "/" (terminals chdir there and run the user's shell as a
    // child), from the first child with a real one.
    cmdProc.command = ["/usr/bin/python3", "-c",
      'import sys, json, base64, os\n' +
      'def cwd_of(p):\n' +
      '    try:\n' +
      '        return os.readlink("/proc/" + p + "/cwd")\n' +
      '    except Exception:\n' +
      '        return ""\n' +
      'def best_cwd(p):\n' +
      '    own = cwd_of(p)\n' +
      '    if own and own != "/":\n' +
      '        return own\n' +
      '    try:\n' +
      '        kids = open("/proc/%s/task/%s/children" % (p, p)).read().split()\n' +
      '    except Exception:\n' +
      '        kids = []\n' +
      '    for k in kids:\n' +
      '        c = cwd_of(k)\n' +
      '        if c and c != "/":\n' +
      '            return c\n' +
      '    return own\n' +
      'for p in sys.argv[1:]:\n' +
      '    try:\n' +
      '        raw = open("/proc/" + p + "/cmdline", "rb").read()\n' +
      '        argv = [a.decode("utf-8", "replace") for a in raw.split(b"\\0") if a]\n' +
      '        if not argv:\n' +
      '            continue\n' +
      '        entry = {"argv": argv}\n' +
      '        d = best_cwd(p)\n' +
      '        if d and d != "/":\n' +
      '            entry["cwd"] = d\n' +
      '        print(p + "\\t" + base64.b64encode(json.dumps(entry).encode()).decode())\n' +
      '    except Exception:\n' +
      '        pass'].concat(pids.map(function(p) { return String(p) }))
    cmdProc.running = true
  }

  Process {
    id: cmdProc
    command: []
    stdout: StdioCollector {
      id: cmdStdout
      waitForEnd: true
      onStreamFinished: {
        if (!root.pending || root.pending.op !== "save") return
        var cmdByPid = {}
        var lines = String(cmdStdout.text || "").split("\n")
        for (var i = 0; i < lines.length; i++) {
          var tab = lines[i].indexOf("\t")
          if (tab === -1) continue
          try {
            cmdByPid[lines[i].slice(0, tab)] =
              JSON.parse(String(Util.decodeBase64(lines[i].slice(tab + 1)) || "[]"))
          } catch (e) {}
        }
        var scene = Reprise.buildScene(root.pending.name, root.snapClients, root.snapActive, cmdByPid)
        // Column data only means something on the scrolling layout.
        if (root.snapLayout === "scrolling")
          Reprise.annotateColumns(scene, root.snapMonitors, root.snapGapsIn)
        scene.savedAt = new Date().toISOString()
        if (scene.windows.length === 0) {
          root.finishOp("nothing on stage to save")
          return
        }
        var file = root.scenesDir + "/" + Reprise.slug(scene.name, 40) + ".json"
        writeProc.command = ["sh", "-c", 'printf %s "$1" > "$2"', "sh",
                             JSON.stringify(scene, null, 2), file]
        writeProc.running = true
      }
    }
  }

  Process {
    id: writeProc
    command: []
    onExited: function(exitCode) {
      root.finishOp(exitCode === 0 ? "" : "could not write the scene file")
      root.scanScenes()
    }
  }

  Process {
    id: runProc
    command: []
    onExited: function(exitCode) {
      if (!root.pending || root.pending.op !== "restore") return
      if (root.pending.stage === "tile") { root.finishRestore(); return }
      // Spawned windows need a beat to map before they can be adopted.
      if (root.pending.unresolved > 0 && root.pending.pass < 5) settleTimer.restart()
      else root.maybeTile()
    }
  }

  // With every window home, reproduce the saved column layout — but only
  // when the scene carries column data and nothing is missing.
  function maybeTile() {
    if (root.pending && root.pending.unresolved === 0
        && Reprise.sceneHasColumns(root.pending.scene)) {
      root.pending.stage = "tile"
      snapProc.running = true
    } else {
      root.finishRestore()
    }
  }

  Timer {
    id: settleTimer
    interval: 1200
    onTriggered: snapProc.running = true
  }

  function finishRestore() {
    var name = root.pending ? root.pending.name : ""
    var unresolved = root.pending ? root.pending.unresolved : 0
    root.finishOp(unresolved > 0 ? unresolved + " window(s) did not return" : "")
    notifyProc.command = ["omarchy-notification-send", "-a", "Reprise",
                          "-u", unresolved > 0 ? "critical" : "normal",
                          unresolved > 0 ? "Scene partly restored" : "Scene restored", name]
    notifyProc.running = true
  }

  Process {
    id: notifyProc
    command: []
  }

  function finishOp(error) {
    root.lastError = error || ""
    root.pending = null
    root.phase = ""
    root.bump()
  }

  // ------------------------------------------------------------------ IPC

  IpcHandler {
    target: "reprise"

    function ping(): string {
      return "ok"
    }

    function list(): string {
      var out = []
      for (var i = 0; i < root.scenes.length; i++) {
        var s = root.scenes[i]
        out.push({ name: s.name, windows: s.windows, workspaces: s.workspaces, savedAt: s.savedAt })
      }
      return JSON.stringify(out)
    }

    function save(name: string): string {
      var r = root.saveScene(name)
      return r.ok ? "ok" : "error " + r.error
    }

    function restore(name: string): string {
      var r = root.restoreScene(name)
      return r.ok ? "ok" : "error " + r.error
    }
  }
}
