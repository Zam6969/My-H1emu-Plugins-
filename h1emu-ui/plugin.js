const fs = require("fs");
const path = require("path");

function resolveH1z1ServerRoot() {
  const candidates = [
    path.join(process.cwd(), "node_modules", "h1z1-server"),
    path.join(__dirname, "..", "..", "node_modules", "h1z1-server"),
    path.join(__dirname, "..", "node_modules", "h1z1-server"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return "h1z1-server";
}

const { BasePlugin } = require(resolveH1z1ServerRoot());

const H1EMU_CUSTOM_OPCODE = 0x99;
const PACKET_ID_UI_CONTROL = 0x10;
const CLIENT_EVENT_OPCODE = "0A";

const UI_OP_CLEAR = 0x01;
const UI_OP_ADD_BUTTON = 0x02;
const UI_OP_ADD_TOGGLE = 0x03;
const UI_OP_SET_VISIBLE = 0x04;
const UI_OP_ADD_SLIDER = 0x05;
const UI_OP_SET_NOCLIP = 0x06;
const UI_OP_SET_NOCLIP_SPEED = 0x07;
const UI_OP_ADD_TEXTINPUT = 0x08;
const UI_OP_SET_PAGE_SIZE = 0x09;
const UI_OP_ADD_LABEL = 0x0A;
const UI_OP_CLEAR_PAGE = 0x0B;
const UI_OP_SET_MANGO_PLATE = 0x0C;
const UI_OP_SET_SERVER_MAP_IMAGE = 0x0D;
const UI_OP_SET_SERVER_MAP_PATH = 0x0E;
const UI_OP_UPDATE_SERVER_MANAGER_PLAYERS = 0x0F;
const UI_OP_UPDATE_GIZMO_OBJECTS = 0x10;
const SERVER_MAP_CHUNK_SIZE = 8192;

function writeString(value) {
  const data = Buffer.from(String(value ?? ""), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length, 0);
  return Buffer.concat([length, data]);
}

function writeFloat(value) {
  const data = Buffer.alloc(4);
  data.writeFloatLE(Number(value) || 0, 0);
  return data;
}

function writeBuffer(value) {
  const data = Buffer.from(value || []);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length, 0);
  return Buffer.concat([length, data]);
}

function makeUiPacket(op, ...chunks) {
  return Buffer.concat([Buffer.from([H1EMU_CUSTOM_OPCODE, PACKET_ID_UI_CONTROL, op]), ...chunks]);
}

function pageName(page) {
  return String(page || "Main");
}

class H1emuUiPlugin extends BasePlugin {
  constructor(server) {
    super(server);
    this.name = "h1emu-ui";
    this.server = server;
    this.callbacks = new Map();
  }

  loadConfig(config) {
    // No configurable options yet.
  }

  async init(server) {
    this.server = server || this.server;
    this.installCustomPacketHandler();
    this.server.h1emuUi = {
      open: this.openUi.bind(this),
      close: (client) => this.setVisible(client, false),
      setVisible: this.setVisible.bind(this),
      clear: this.clear.bind(this),
      addButton: this.addButton.bind(this),
      addToggle: this.addToggle.bind(this),
      addSlider: this.addSlider.bind(this),
      addTextInput: this.addTextInput.bind(this),
      addLabel: this.addLabel.bind(this),
      clearPage: this.clearPage.bind(this),
      setNoclip: this.setNoclip.bind(this),
      setNoclipSpeed: this.setNoclipSpeed.bind(this),
      setMongo: this.setMongo.bind(this),
      sendServerMapImage: this.sendServerMapImage.bind(this),
      setServerMapImagePath: this.setServerMapImagePath.bind(this),
      updateServerManagerPlayers: this.updateServerManagerPlayers.bind(this),
      updateGizmoObjects: this.updateGizmoObjects.bind(this),
      setPageSize: this.setPageSize.bind(this),
      rebuild: this.rebuild.bind(this),
      onGizmoMove: null,
    };
  }

  openUi(client) {
    this.setVisible(client, true);
  }

  static openUiPacket() {
    return Buffer.from([H1EMU_CUSTOM_OPCODE, PACKET_ID_UI_CONTROL, UI_OP_SET_VISIBLE, 1]);
  }

  setVisible(client, visible) {
    this.sendUiPacket(client, makeUiPacket(UI_OP_SET_VISIBLE, Buffer.from([visible ? 1 : 0])));
  }

  clear(client) {
    this.removeClientCallbacks(client);
    this.sendUiPacket(client, makeUiPacket(UI_OP_CLEAR));
  }

  clearPage(client, page = "Main") {
    if (!client) return;
    this.sendUiPacket(client, makeUiPacket(UI_OP_CLEAR_PAGE, writeString(pageName(page))));
  }

  addButton(client, id, label, onClick, page = "Main") {
    if (!client || !id) return;
    this.callbacks.set(this.callbackKey(client, id), {
      type: "button",
      onClick: typeof onClick === "function" ? onClick : undefined,
    });
    this.sendUiPacket(client, makeUiPacket(UI_OP_ADD_BUTTON, writeString(id), writeString(label), writeString(pageName(page))));
  }

  addToggle(client, id, label, value = false, onChange, page = "Main") {
    if (!client || !id) return;
    if (typeof value === "function") {
      onChange = value;
      value = false;
    }
    this.callbacks.set(this.callbackKey(client, id), {
      type: "toggle",
      onChange: typeof onChange === "function" ? onChange : undefined,
    });
    this.sendUiPacket(
      client,
      makeUiPacket(UI_OP_ADD_TOGGLE, writeString(id), writeString(label), writeString(pageName(page)), Buffer.from([value ? 1 : 0]))
    );
  }

  addSlider(client, id, label, value = 0, min = 0, max = 100, onChange, page = "Main") {
    if (!client || !id) return;
    this.callbacks.set(this.callbackKey(client, id), {
      type: "slider",
      onChange: typeof onChange === "function" ? onChange : undefined,
    });
    this.sendUiPacket(
      client,
      makeUiPacket(
        UI_OP_ADD_SLIDER,
        writeString(id),
        writeString(label),
        writeString(pageName(page)),
        writeFloat(value),
        writeFloat(min),
        writeFloat(max)
      )
    );
  }

  setNoclip(client, enabled) {
    this.sendUiPacket(client, makeUiPacket(UI_OP_SET_NOCLIP, Buffer.from([enabled ? 1 : 0])));
  }

  setNoclipSpeed(client, value) {
    this.sendUiPacket(client, makeUiPacket(UI_OP_SET_NOCLIP_SPEED, writeFloat(value)));
  }

  setMongo(client, enabled) {
    this.sendUiPacket(client, makeUiPacket(UI_OP_SET_MANGO_PLATE, Buffer.from([enabled ? 1 : 0])));
  }

  sendServerMapImage(client, data) {
    if (!client || !data || !data.length) return;
    const buffer = Buffer.from(data);
    for (let offset = 0; offset < buffer.length; offset += SERVER_MAP_CHUNK_SIZE) {
      const chunk = buffer.subarray(offset, Math.min(offset + SERVER_MAP_CHUNK_SIZE, buffer.length));
      const reset = offset === 0 ? 1 : 0;
      const done = offset + chunk.length >= buffer.length ? 1 : 0;
      this.sendUiPacket(client, makeUiPacket(UI_OP_SET_SERVER_MAP_IMAGE, Buffer.from([reset, done]), writeBuffer(chunk)));
    }
  }

  setServerMapImagePath(client, path) {
    if (!client || !path) return;
    this.sendUiPacket(client, makeUiPacket(UI_OP_SET_SERVER_MAP_PATH, writeString(path)));
  }

  updateServerManagerPlayers(client, payload) {
    if (!client) return;
    this.sendUiPacket(client, makeUiPacket(UI_OP_UPDATE_SERVER_MANAGER_PLAYERS, writeString(payload || "")));
  }

  updateGizmoObjects(client, payload) {
    if (!client) return;
    this.sendUiPacket(client, makeUiPacket(UI_OP_UPDATE_GIZMO_OBJECTS, writeString(payload || "")));
  }

  setPageSize(client, page, width, height) {
    if (!client) return;
    this.sendUiPacket(client, makeUiPacket(UI_OP_SET_PAGE_SIZE, writeString(pageName(page)), writeFloat(width), writeFloat(height)));
  }

  addTextInput(client, id, label, value = "", onChange, page = "Main") {
    if (!client || !id) return;
    this.callbacks.set(this.callbackKey(client, id), {
      type: "text",
      onTextChanged: typeof onChange === "function" ? onChange : undefined,
    });
    this.sendUiPacket(
      client,
      makeUiPacket(
        UI_OP_ADD_TEXTINPUT,
        writeString(id),
        writeString(label),
        writeString(pageName(page)),
        writeString(String(value ?? ""))
      )
    );
  }

  addLabel(client, label, page = "Main") {
    if (!client) return;
    this.sendUiPacket(client, makeUiPacket(UI_OP_ADD_LABEL, writeString(label), writeString(pageName(page))));
  }

  rebuild(client, controls = [], options = {}) {
    const pages = [...new Set(controls.map((c) => pageName(c.page)))];
    for (const page of pages) {
      this.clearPage(client, page);
    }
    for (const control of controls) {
      if (control.type === "button") {
        this.addButton(client, control.id, control.label, control.onClick, control.page);
      } else if (control.type === "toggle") {
        this.addToggle(client, control.id, control.label, control.value, control.onChange, control.page);
      } else if (control.type === "slider") {
        this.addSlider(client, control.id, control.label, control.value, control.min, control.max, control.onChange, control.page);
      } else if (control.type === "text") {
        this.addTextInput(client, control.id, control.label, control.value, control.onChange, control.page);
      } else if (control.type === "label") {
        this.addLabel(client, control.label, control.page);
      }
    }
    if (options.open !== false) {
      this.openUi(client);
    }
  }

  sendUiPacket(client, packet) {
    if (!client || !packet) return;
    this.installCustomPacketHandler();
    this.server.sendRawDataReliable(client, packet);
  }

  clientKey(client) {
    return client?.loginSessionId || client?.soeClientId || client?.character?.characterId || "unknown";
  }

  callbackKey(client, id) {
    return `${this.clientKey(client)}:${id}`;
  }

  removeClientCallbacks(client) {
    const prefix = `${this.clientKey(client)}:`;
    for (const key of this.callbacks.keys()) {
      if (key.startsWith(prefix)) {
        this.callbacks.delete(key);
      }
    }
  }

  installCustomPacketHandler() {
    const handlers = this.server?._packetHandlers;
    if (!handlers || handlers.__h1emuUiPatched || typeof handlers.handleCustomPacket !== "function") return;

    const originalHandleCustomPacket = handlers.handleCustomPacket.bind(handlers);
    handlers.handleCustomPacket = (server, client, raw) => {
      raw = String(raw ?? "");
      const opcode = raw.substring(0, 2).toUpperCase();
      if (opcode === CLIENT_EVENT_OPCODE) {
        this.handleUiEvent(client, raw.slice(2));
        return;
      }
      originalHandleCustomPacket(server, client, raw);
    };
    handlers.__h1emuUiPatched = true;
  }

  handleUiEvent(client, rawJson) {
    let event;
    try {
      event = JSON.parse(rawJson);
    } catch (error) {
      console.warn(`[h1emu-ui] Invalid UI event payload from ${this.clientKey(client)}: ${rawJson}`);
      return;
    }

    const type = String(event.type || "");
    const id = String(event.id || "");

    if (type === "gizmo") {
      let data;
      try {
        data = JSON.parse(event.value || "{}");
      } catch { return; }
      if (data.action === "move" && typeof this.onGizmoMove === "function") {
        this.onGizmoMove(client, id, Number(data.x) || 0, Number(data.y) || 0, Number(data.z) || 0);
      }
      return;
    }

    const callback = this.callbacks.get(this.callbackKey(client, id));
    if (!callback || callback.type !== type) return;

    if (type === "button" && callback.onClick) {
      callback.onClick(this.server, client, event);
    } else if (type === "toggle" && callback.onChange) {
      callback.onChange(this.server, client, Boolean(event.value), event);
    } else if (type === "slider" && callback.onChange) {
      callback.onChange(this.server, client, Number(event.value), event);
    } else if (type === "text" && callback.onTextChanged) {
      callback.onTextChanged(this.server, client, String(event.value ?? ""), event);
    }
  }

  commands = [
    {
      name: "ui",
      description: "Open the H1emu client patch UI menu",
      permissionLevel: 0,
      keepCase: false,
      execute: (server, client) => {
        this.openUi(client);
      },
    },

  ];
}

module.exports = H1emuUiPlugin;
