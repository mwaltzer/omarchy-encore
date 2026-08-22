import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import QtQuick
import qs.Commons
import qs.Ui

Item {
  id: root

  // Injected by omarchy-shell.
  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null
  property var barWidgetRegistry: null
  property var pluginRegistry: null
  // The matching service singleton, handed over by the shell.
  property var service: null

  readonly property color fg: Color.popups.text
  readonly property color cardBg: Color.popups.background
  readonly property color mutedColor: Color.muted
  readonly property color urgentColor: Color.urgent
  readonly property color accentColor: Color.accent
  readonly property color scrimColor: Qt.rgba(Color.background.r, Color.background.g, Color.background.b, 0.62)
  readonly property color hairline: Qt.rgba(mutedColor.r, mutedColor.g, mutedColor.b, 0.22)
  readonly property color selectionTint: Qt.rgba(fg.r, fg.g, fg.b, 0.08)
  readonly property color hoverTint: Qt.rgba(fg.r, fg.g, fg.b, 0.04)

  property bool opened: false
  property var scenes: []
  property int selectedIndex: -1
  property string selectedName: ""
  property string localError: ""
  property string armedDelete: ""

  function open(payload) {
    root.opened = true
    // Scenes are plain files the user may edit or sync behind our back.
    if (root.service) service.scanScenes()
    root.refresh()
    root.localError = ""
    root.armedDelete = ""
    nameInput.text = ""
    root.select(0)
    // The window may not be mapped yet; focus again once it is.
    root.focusInitial()
    Qt.callLater(root.focusInitial)
  }

  // Restore is the primary act: land on the list when there is one.
  function focusInitial() {
    if (!root.opened) return
    if (root.scenes.length > 0) keyCatcher.forceActiveFocus()
    else nameInput.forceActiveFocus()
  }

  function close() {
    root.opened = false
    root.localError = ""
    root.armedDelete = ""
  }

  function hide() { root.close() }

  function toggle() {
    if (root.opened) root.close()
    else root.open({})
  }

  function refresh() {
    if (!root.service) return
    root.scenes = service.scenes
    var idx = -1
    for (var i = 0; i < root.scenes.length; i++) {
      if (root.scenes[i].name === root.selectedName) { idx = i; break }
    }
    root.select(idx >= 0 ? idx : root.selectedIndex)
  }

  onOpenedChanged: if (opened) Qt.callLater(root.refresh)
  onServiceChanged: if (service) refresh()

  Connections {
    target: root.service ? root.service : null
    function onRevisionChanged() { root.refresh() }
  }

  PanelWindow {
    id: panel

    visible: root.opened
    onVisibleChanged: if (visible) Qt.callLater(root.focusInitial)
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "omarchy-encore"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: root.scrimColor

      MouseArea {
        anchors.fill: parent
        onClicked: root.close()
      }
    }

    BorderSurface {
      id: card

      // The card hugs its content: chrome plus however many rows there
      // are, never less than a stage for the empty state, never more
      // than most of the screen.
      readonly property real chromeHeight:
        Style.space(24) * 2 + header.height + Style.space(20) + nameInput.height
        + (errorLine.visible ? errorLine.implicitHeight + Style.space(8) : 0)
        + Style.space(20) + 1 + Style.space(8)
        + Style.space(8) + 1 + Style.space(12) + footer.height

      width: Math.min(Style.space(640), parent.width * 0.9)
      height: Math.min(chromeHeight + Math.max(listView.contentHeight, Style.space(150)),
                       parent.height * 0.8)
      anchors.centerIn: parent
      color: root.cardBg
      borderSpec: Border.localOrSurfaceSpec("popups", "border", Color.popups.border, Color.popups.border, Math.max(1, Style.space(2)))
      radius: Style.cornerRadius
      padding: 0

      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        id: content

        anchors.fill: parent
        anchors.margins: Style.space(24)

        Item {
          id: keyCatcher

          anchors.fill: parent
          focus: true
          Keys.onPressed: function(event) { root.handleListKeys(event) }

          // -------------------------------------------------------- header

          Item {
            id: header

            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            height: crest.implicitHeight

            Text {
              id: crest

              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              text: "\u2756"
              color: root.accentColor
              font.family: Style.font.family
              font.pixelSize: Style.font.iconLarge
            }

            Text {
              anchors.left: crest.right
              anchors.leftMargin: Style.space(12)
              anchors.verticalCenter: parent.verticalCenter
              text: "ENCORE"
              color: root.fg
              font.family: Style.font.family
              font.pixelSize: Style.font.subtitle
              font.letterSpacing: 3
            }

            Text {
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              text: root.summaryLine()
              color: root.mutedColor
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }

          // --------------------------------------------------------- input

          TextField {
            id: nameInput

            anchors.top: header.bottom
            anchors.topMargin: Style.space(20)
            anchors.left: parent.left
            anchors.right: parent.right
            placeholderText: "Name this scene, Enter saves the stage..."
            text: ""
            onTextEdited: { root.localError = ""; root.armedDelete = "" }
            Keys.onPressed: function(event) { root.handleInputKeys(event) }
          }

          Text {
            id: errorLine

            anchors.top: nameInput.bottom
            anchors.topMargin: Style.space(8)
            anchors.left: parent.left
            anchors.right: parent.right
            visible: root.errorText().length > 0
            text: root.errorText()
            color: root.urgentColor
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          Rectangle {
            id: listRule

            anchors.top: errorLine.visible ? errorLine.bottom : nameInput.bottom
            anchors.topMargin: Style.space(20)
            anchors.left: parent.left
            anchors.right: parent.right
            height: 1
            color: root.hairline
          }

          // ---------------------------------------------------------- list

          ListView {
            id: listView

            anchors.top: listRule.bottom
            anchors.topMargin: Style.space(8)
            anchors.bottom: footRule.top
            anchors.bottomMargin: Style.space(8)
            anchors.left: parent.left
            anchors.right: parent.right
            clip: true
            model: root.scenes
            spacing: 0
            boundsBehavior: Flickable.StopAtBounds

            delegate: SceneRow {
              required property var modelData
              required property int index

              scene: modelData
              rowIndex: index
            }
          }

          Column {
            anchors.centerIn: listView
            visible: root.scenes.length === 0
            spacing: Style.space(10)

            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              text: "\u2756"
              color: root.mutedColor
              opacity: 0.5
              font.family: Style.font.family
              font.pixelSize: Style.font.display
            }

            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              text: "An empty stage. Name a scene above to set it."
              color: root.mutedColor
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }
          }

          // -------------------------------------------------------- footer

          Rectangle {
            id: footRule

            anchors.bottom: footer.top
            anchors.bottomMargin: Style.space(12)
            anchors.left: parent.left
            anchors.right: parent.right
            height: 1
            color: root.hairline
          }

          Text {
            id: footer

            anchors.bottom: parent.bottom
            anchors.horizontalCenter: parent.horizontalCenter
            text: "tab/arrows select - enter restore - s new scene - r resave - x delete - esc close"
            color: root.mutedColor
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }
      }
    }
  }

  // ------------------------------------------------------------- keyboard

  function handleInputKeys(event) {
    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      root.save()
      event.accepted = true
    } else if (event.key === Qt.Key_Down) {
      root.focusList(1)
      event.accepted = true
    } else if (event.key === Qt.Key_Up) {
      root.focusList(-1)
      event.accepted = true
    } else if (event.key === Qt.Key_Tab) {
      root.cycle(1)
      event.accepted = true
    } else if (event.key === Qt.Key_Backtab) {
      root.cycle(-1)
      event.accepted = true
    } else if (event.key === Qt.Key_Escape) {
      if (root.scenes.length > 0) {
        nameInput.text = ""
        keyCatcher.forceActiveFocus()
      } else {
        root.close()
      }
      event.accepted = true
    }
  }

  function handleListKeys(event) {
    var scene = root.selectedScene()
    if (event.key === Qt.Key_Down || event.key === Qt.Key_J) {
      root.select(root.selectedIndex + 1)
      event.accepted = true
    } else if (event.key === Qt.Key_Up || event.key === Qt.Key_K) {
      root.select(root.selectedIndex - 1)
      event.accepted = true
    } else if (event.key === Qt.Key_Home) {
      root.select(0)
      event.accepted = true
    } else if (event.key === Qt.Key_End) {
      root.select(root.scenes.length - 1)
      event.accepted = true
    } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      if (scene) root.restore(scene.name)
      event.accepted = true
    } else if (event.key === Qt.Key_X) {
      if (scene) root.deleteStep(scene.name)
      event.accepted = true
    } else if (event.key === Qt.Key_R) {
      if (scene) {
        nameInput.text = scene.name
        nameInput.cursorPosition = nameInput.text.length
        nameInput.forceActiveFocus()
      }
      event.accepted = true
    } else if (event.key === Qt.Key_Tab) {
      root.cycle(1)
      event.accepted = true
    } else if (event.key === Qt.Key_Backtab) {
      root.cycle(-1)
      event.accepted = true
    } else if (event.key === Qt.Key_S) {
      nameInput.forceActiveFocus()
      event.accepted = true
    } else if (event.key === Qt.Key_Escape) {
      if (root.armedDelete.length > 0) root.armedDelete = ""
      else root.close()
      event.accepted = true
    }
  }

  function cycle(step) {
    if (root.scenes.length === 0) return
    keyCatcher.forceActiveFocus()
    var n = root.scenes.length
    root.select(((root.selectedIndex + step) % n + n) % n)
  }

  function focusList(step) {
    if (root.scenes.length === 0) return
    keyCatcher.forceActiveFocus()
    if (root.selectedIndex < 0) root.select(step >= 0 ? 0 : root.scenes.length - 1)
    else root.select(root.selectedIndex + step)
  }

  // -------------------------------------------------------------- helpers

  function select(i) {
    if (root.scenes.length === 0) {
      root.selectedIndex = -1
      root.selectedName = ""
      root.armedDelete = ""
      return
    }
    var c = Math.max(0, Math.min(i, root.scenes.length - 1))
    var moved = c !== root.selectedIndex || root.scenes[c].name !== root.selectedName
    root.selectedIndex = c
    root.selectedName = root.scenes[c].name
    if (moved) {
      root.armedDelete = ""
      listView.positionViewAtIndex(c, ListView.Contain)
    }
  }

  function selectedScene() {
    if (root.selectedIndex < 0 || root.selectedIndex >= root.scenes.length) return null
    return root.scenes[root.selectedIndex]
  }

  function save() {
    if (!root.service) return
    var result = service.saveScene(nameInput.text)
    if (result.ok) {
      root.selectedName = String(nameInput.text || "").trim()
      nameInput.text = ""
      root.localError = ""
      // Land on the freshly saved scene so Enter can bring it right back.
      keyCatcher.forceActiveFocus()
    } else {
      root.localError = result.error
    }
  }

  function restore(name) {
    if (!root.service) return
    var result = service.restoreScene(name)
    if (result.ok) root.close()
    else root.localError = result.error
  }

  function deleteStep(name) {
    if (root.armedDelete === name) {
      if (root.service) service.deleteScene(name)
      root.armedDelete = ""
    } else {
      root.armedDelete = name
    }
  }

  function errorText() {
    if (root.localError.length > 0) return root.localError
    return root.service ? String(service.lastError || "") : ""
  }

  function summaryLine() {
    var phase = root.service ? String(service.phase || "") : ""
    if (phase === "saving") return "saving the stage..."
    if (phase === "restoring") return "raising the curtain..."
    var n = root.scenes.length
    return n + (n === 1 ? " scene" : " scenes")
  }

  function savedDay(iso) {
    if (!iso) return ""
    var d = new Date(iso)
    if (isNaN(d.getTime())) return ""
    return Qt.formatDateTime(d, "MMM d")
  }

  component SceneRow : Item {
    id: rowRoot

    property var scene: ({})
    property int rowIndex: -1

    readonly property bool selected: rowIndex === root.selectedIndex
    readonly property bool armed: root.armedDelete === scene.name

    width: listView.width
    height: Style.space(52)

    Rectangle {
      anchors.fill: parent
      radius: Style.cornerRadius
      color: rowRoot.selected ? root.selectionTint
           : rowHover.containsMouse ? root.hoverTint : "transparent"

      Behavior on color {
        ColorAnimation { duration: 120 }
      }
    }

    MouseArea {
      id: rowHover

      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: {
        root.select(rowRoot.rowIndex)
        keyCatcher.forceActiveFocus()
      }
      onDoubleClicked: root.restore(rowRoot.scene.name)
    }

    Text {
      id: glyph

      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      text: "\u2756"
      color: rowRoot.selected ? root.accentColor : root.mutedColor
      font.family: Style.font.family
      font.pixelSize: Style.font.bodySmall

      Behavior on color {
        ColorAnimation { duration: 120 }
      }
    }

    Column {
      anchors.left: glyph.right
      anchors.leftMargin: Style.space(14)
      anchors.right: dayLabel.left
      anchors.rightMargin: Style.space(14)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(3)

      Text {
        width: parent.width
        text: rowRoot.scene.name || ""
        color: root.fg
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        elide: Text.ElideRight
      }

      Text {
        width: parent.width
        text: rowRoot.armed
          ? "press x again to delete"
          : rowRoot.scene.windows + (rowRoot.scene.windows === 1 ? " window - " : " windows - ")
            + rowRoot.scene.workspaces
            + (rowRoot.scene.workspaces === 1 ? " workspace" : " workspaces")
        color: rowRoot.armed ? root.urgentColor : root.mutedColor
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }
    }

    Text {
      id: dayLabel

      anchors.right: parent.right
      anchors.rightMargin: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      text: root.savedDay(rowRoot.scene.savedAt)
      color: root.mutedColor
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
    }
  }
}
