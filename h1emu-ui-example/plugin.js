const { BasePlugin } = require("C:/Users/zam/Documents/H1emu/H1EmuServerFiles/h1z1-server-QuickStart-master/node_modules/h1z1-server");

const ADMIN_PERMISSION = 2;
const ADMIN_CHECK_ATTEMPTS = 8;
const ADMIN_CHECK_DELAY_MS = 250;
const RUN_SPEED_MIN = 1;
const RUN_SPEED_MAX = 100;
const RUN_SPEED_DEFAULT = 1;
const TIME_OF_DAY_MIN = 0;
const TIME_OF_DAY_MAX = 24;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const KICK_REASON = "Admin UI kick";
const BAN_REASON = "Admin UI ban";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class H1emuUiExamplePlugin extends BasePlugin {
  constructor(server) {
    super(server);
    this.name = "h1emu-ui-example";
    this.server = server;
    this.runSpeeds = new Map();
  }

  loadConfig(config) {
    // No configurable options; this is an example plugin.
  }

  async init(server) {
    this.server = server || this.server;
  }

  clientKey(client) {
    return client?.loginSessionId || client?.soeClientId || client?.character?.characterId || "unknown";
  }

  playerName(client) {
    return client?.character?.name || client?.loginSessionId || "unknown player";
  }

  notify(server, client, message) {
    if (typeof server.sendAlert === "function") {
      server.sendAlert(client, message);
    } else if (typeof server.sendChatText === "function") {
      server.sendChatText(client, message);
    }
  }

  isAdmin(client) {
    return client?.isAdmin === true || (client?.permissionLevel || 0) >= ADMIN_PERMISSION;
  }

  async waitForAdmin(client) {
    for (let i = 0; i < ADMIN_CHECK_ATTEMPTS; i += 1) {
      if (this.isAdmin(client)) return true;
      await sleep(ADMIN_CHECK_DELAY_MS);
    }
    return this.isAdmin(client);
  }

  requireUi(server, client) {
    if (server.h1emuUi) return true;
    this.notify(server, client, "h1emu-ui must be loaded before h1emu-ui-example.");
    return false;
  }

  connectedPlayers(server) {
    return Object.values(server._clients || {})
      .filter((client) => client?.loginSessionId && client?.character?.name)
      .sort((a, b) => this.playerName(a).localeCompare(this.playerName(b)));
  }

  getTargetClient(server, loginSessionId) {
    if (!loginSessionId) return undefined;
    if (typeof server.getClientByLoginSessionId === "function") {
      return server.getClientByLoginSessionId(loginSessionId);
    }
    return Object.values(server._clients || {}).find((client) => client?.loginSessionId === loginSessionId);
  }

  applyRunSpeed(server, client, value) {
    if (!this.isAdmin(client)) return;

    const key = this.clientKey(client);
    const nextSpeed = clamp(Math.round(Number(value) || RUN_SPEED_DEFAULT), RUN_SPEED_MIN, RUN_SPEED_MAX);
    const previousSpeed = this.runSpeeds.get(key) || RUN_SPEED_DEFAULT;

    if (previousSpeed !== RUN_SPEED_DEFAULT) {
      server.sendData(client, "ClientUpdate.ModifyMovementSpeed", { speed: 1 / previousSpeed });
    }

    if (nextSpeed !== RUN_SPEED_DEFAULT) {
      server.sendData(client, "ClientUpdate.ModifyMovementSpeed", { speed: nextSpeed });
    }

    this.runSpeeds.set(key, nextSpeed);
  }

  currentTimeOfDay(server) {
    const seconds = Number(server.inGameTimeManager?.time || 0);
    return clamp(seconds / SECONDS_PER_HOUR, TIME_OF_DAY_MIN, TIME_OF_DAY_MAX);
  }

  applyTimeOfDay(server, client, value) {
    if (!this.isAdmin(client)) return;
    if (!server.inGameTimeManager) return;

    const hour = clamp(Number(value) || 0, TIME_OF_DAY_MIN, TIME_OF_DAY_MAX);
    server.inGameTimeManager.time = Math.round((hour % TIME_OF_DAY_MAX) * SECONDS_PER_HOUR) % SECONDS_PER_DAY;
    server.inGameTimeManager.lastIngameTimeUpdate = null;

    for (const targetClient of Object.values(server._clients || {})) {
      server.sendGameTimeSync(targetClient);
    }
  }

  baseControls(server, client) {
    const key = this.clientKey(client);
    const currentSpeed = this.runSpeeds.get(key) || RUN_SPEED_DEFAULT;

    return [
      {
        type: "toggle",
        id: "example_godmode",
        label: "God Mode",
        value: Boolean(client.character?.godMode),
        onChange: (server, client, enabled) => {
          if (!this.isAdmin(client)) return;
          server.setGodMode(client, enabled);
          this.notify(server, client, `God Mode ${enabled ? "enabled" : "disabled"}.`);
        },
      },
      {
        type: "slider",
        id: "example_runspeed",
        label: "Run Speed",
        value: currentSpeed,
        min: RUN_SPEED_MIN,
        max: RUN_SPEED_MAX,
        onChange: (server, client, value) => {
          this.applyRunSpeed(server, client, value);
        },
      },
      {
        type: "slider",
        id: "example_timeofday",
        label: "Time of Day",
        value: this.currentTimeOfDay(server),
        min: TIME_OF_DAY_MIN,
        max: TIME_OF_DAY_MAX,
        onChange: (server, client, value) => {
          this.applyTimeOfDay(server, client, value);
        },
      },
      {
        type: "button",
        id: "example_show_players",
        label: "Show All Connected Players",
        onClick: (server, client) => {
          this.showPlayerList(server, client);
        },
      },
    ];
  }

  sendMenu(server, client, extraControls = []) {
    if (!this.isAdmin(client)) return;
    if (!this.requireUi(server, client)) return;
    server.h1emuUi.rebuild(client, [...this.baseControls(server, client), ...extraControls]);
  }

  async openMenu(server, client) {
    if (!(await this.waitForAdmin(client))) return;
    this.notify(server, client, "Confirmed admin status.");
    this.sendMenu(server, client);
  }

  showPlayerList(server, client) {
    if (!this.isAdmin(client)) return;

    const players = this.connectedPlayers(server);
    const controls = [
      {
        type: "button",
        id: "example_players_header",
        label: `Connected Players (${players.length})`,
        onClick: () => {},
      },
      ...players.map((target) => ({
        type: "button",
        id: `example_player_${target.loginSessionId}`,
        label: this.playerName(target),
        onClick: (server, client) => {
          this.showPlayerActions(server, client, target.loginSessionId);
        },
      })),
    ];

    this.sendMenu(server, client, controls);
  }

  showPlayerActions(server, client, loginSessionId) {
    if (!this.isAdmin(client)) return;

    const target = this.getTargetClient(server, loginSessionId);
    if (!target) {
      this.notify(server, client, "Selected player is no longer connected.");
      this.showPlayerList(server, client);
      return;
    }

    const name = this.playerName(target);
    this.sendMenu(server, client, [
      {
        type: "button",
        id: "example_selected_player",
        label: `Selected: ${name}`,
        onClick: () => {},
      },
      {
        type: "button",
        id: "example_selected_kick",
        label: `Kick ${name}`,
        onClick: (server, client) => {
          this.kickTarget(server, client, loginSessionId);
        },
      },
      {
        type: "button",
        id: "example_selected_silent_ban",
        label: `Silent Ban ${name}`,
        onClick: (server, client) => {
          this.banTarget(server, client, loginSessionId, true).catch((error) => console.error(error));
        },
      },
      {
        type: "button",
        id: "example_selected_ban",
        label: `Ban ${name}`,
        onClick: (server, client) => {
          this.banTarget(server, client, loginSessionId, false).catch((error) => console.error(error));
        },
      },
      {
        type: "button",
        id: "example_back_to_players",
        label: "Back To Player List",
        onClick: (server, client) => {
          this.showPlayerList(server, client);
        },
      },
    ]);
  }

  canModerateTarget(server, adminClient, targetClient, action) {
    if (!this.isAdmin(adminClient)) return false;
    if (!targetClient) {
      this.notify(server, adminClient, "Selected player is no longer connected.");
      return false;
    }
    if (targetClient.loginSessionId === adminClient.loginSessionId) {
      this.notify(server, adminClient, `You cannot ${action} yourself.`);
      return false;
    }
    return true;
  }

  kickTarget(server, client, loginSessionId) {
    const target = this.getTargetClient(server, loginSessionId);
    if (!this.canModerateTarget(server, client, target, "kick")) return;

    const name = this.playerName(target);
    server.kickPlayerWithReason(target, KICK_REASON, true);
    this.notify(server, client, `Kick sent for ${name}.`);
    this.showPlayerList(server, client);
  }

  async banTarget(server, client, loginSessionId, isSilent) {
    const target = this.getTargetClient(server, loginSessionId);
    if (!this.canModerateTarget(server, client, target, isSilent ? "silent ban" : "ban")) return;

    const name = this.playerName(target);
    const existingBan = await server._db?.collection("banned").findOne({ loginSessionId, active: true });
    if (existingBan) {
      this.notify(server, client, `${name} is already banned.`);
      return;
    }

    await server.banClient(loginSessionId, name, BAN_REASON, client.loginSessionId, 0, isSilent);
    this.notify(server, client, `${isSilent ? "Silent ban" : "Ban"} sent for ${name}.`);
    this.showPlayerList(server, client);
  }

  commands = [
    {
      name: "uiexample",
      description: "Open an example H1emu UI with God Mode, Run Speed, and Time of Day controls",
      permissionLevel: ADMIN_PERMISSION,
      keepCase: false,
      execute: async (server, client) => {
        await this.openMenu(server, client);
      },
    },
  ];
}

module.exports = H1emuUiExamplePlugin;
