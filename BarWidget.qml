import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "mcw.encore"

  readonly property string home: Quickshell.env("HOME")
  readonly property string scenesDir: home + "/.config/omarchy/encore/scenes"

  property int sceneCount: 0

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Timer {
    interval: 5000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.readCount()
  }

  function readCount() {
    if (counter.running) return
    counter.running = true
  }

  Process {
    id: counter
    command: ["sh", "-c", 'ls "$1"/*.json 2>/dev/null | wc -l', "sh", root.scenesDir]
    stdout: StdioCollector {
      id: countOut
      waitForEnd: true
      onStreamFinished: {
        var n = parseInt(String(countOut.text || "").trim(), 10)
        root.sceneCount = isFinite(n) ? n : 0
      }
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\u259A"
    tooltipText: root.sceneCount > 0
      ? "Encore - " + root.sceneCount + (root.sceneCount === 1 ? " scene" : " scenes")
      : "Encore"
    dimmed: root.sceneCount === 0
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.LeftButton)
        Quickshell.execDetached(["omarchy-shell", "shell", "toggle", root.moduleName, "{}"])
    }
  }
}
