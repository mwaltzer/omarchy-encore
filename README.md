# Encore

![Encore restoring a scene: windows close, one keypress brings them all back](demo.gif)

Workspace scenes for Omarchy. Save the stage; restore it with one key.
Apps launch and fly into their places — workspace by workspace, floats
back at their exact spots.

Hyprland has no session management. Encore is the missing curtain call:
name the layout you are in, and any time later — after a reboot, after a
"close everything" sweep — bring the whole arrangement back.

## Use

- Open the picker (bar icon or your keybind). Enter restores the selected
  scene: windows that are already running are adopted and moved into
  place; missing apps are launched, then adopted into position as their
  windows appear — in passes, so slow starters and single-instance apps
  arrive correctly too.
- Press `s`, type a name, press Enter to save the current stage —
  windows, workspaces, and float positions — as a new scene.
- `up/down` or `j/k` select, `r` prefills a scene name to re-save,
  `x` twice deletes, `Esc` closes.

Scenes are plain JSON files in `~/.config/omarchy/encore/scenes/` —
inspect them, edit them, sync them between machines.

Optional keybind in `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + E", "Encore", "omarchy-shell shell toggle mcw.encore '{}'")
```

## IPC

```
omarchy-shell encore list
omarchy-shell encore save "deep work"
omarchy-shell encore restore "deep work"
```

Restore from a boot script, a cron, or another machine over SSH.

## Notes and limits

- Launch commands come from `/proc/<pid>/cmdline` at save time, with
  argument boundaries preserved — flags with spaces survive the round trip.
- Chromium web apps are recognized by window class and relaunched through
  `omarchy-launch-webapp`.
- Floating windows come back at their exact position and size; fullscreen
  and pinned states are restored too. Tiled windows are restored to their
  workspace and tile naturally — Encore does not try to reproduce exact
  tiling splits.
- A relaunched app whose window class changed is still adopted: windows
  that appear during a restore are matched to the remaining slots.
- Scenes restore windows to workspaces; multi-monitor workspace
  assignments follow however your workspaces are bound to monitors.

## Development

The planning logic is pure JavaScript in `Encore.js`, covered by a
frameworkless test suite:

```
node tests/encore.test.mjs
```

QML lint: `qmllint -I /usr/share/omarchy/shell *.qml`

MIT licensed.
