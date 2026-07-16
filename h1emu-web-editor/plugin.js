const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

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

const h1z1ServerRoot = resolveH1z1ServerRoot();
const { BasePlugin } = require(h1z1ServerRoot);
const enums = require(path.join(h1z1ServerRoot, "out", "servers", "ZoneServer2016", "models", "enums"));
const { movePoint, getCubeBounds, getAppDataFolderPath, eul2quat } = require(path.join(h1z1ServerRoot, "out", "utils", "utils"));
const { ConstructionParentEntity } = require(path.join(h1z1ServerRoot, "out", "servers", "ZoneServer2016", "entities", "constructionparententity"));
const { ConstructionDoor } = require(path.join(h1z1ServerRoot, "out", "servers", "ZoneServer2016", "entities", "constructiondoor"));
const { PluginManager } = require(path.join(h1z1ServerRoot, "out", "servers", "ZoneServer2016", "managers", "pluginmanager"));
const { WorldDataManager } = require(path.join(h1z1ServerRoot, "out", "servers", "ZoneServer2016", "managers", "worlddatamanager"));
const { DB_COLLECTIONS } = require(path.join(h1z1ServerRoot, "out", "utils", "enums"));
const dme = require(path.join(__dirname, "lib-dme.js"));

const SERVER_MAP_COORD_SIZE = 1000;
const SERVER_MAP_LEFT_Z = -4097;
const SERVER_MAP_RIGHT_Z = (4077 + 4098) / 2;
const SERVER_MAP_TOP_X = (4102 + 4097) / 2;
const SERVER_MAP_BOTTOM_X = -4092;
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const AUTH_MESSAGE_TIMEOUT_MS = 3000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const BODY_LIMIT_BYTES = 10 * 1024;
const SCAN_INTERVAL_MS = 500;
const PLAYER_INTERVAL_MS = 1000;

const ITEM_NAME_BY_ID = Object.fromEntries(Object.entries(enums.Items).filter(([, value]) => typeof value === "number").map(([key, value]) => [value, key]));
const MODEL_NAME_BY_ID = Object.fromEntries(Object.entries(enums.ModelIds || {}).filter(([, value]) => typeof value === "number").map(([key, value]) => [value, key]));

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function vector3(value, fallback = [0, 0, 0]) {
  if (!value || typeof value.length !== "number") return fallback.slice();
  return [toNumber(value[0], fallback[0]), toNumber(value[1], fallback[1]), toNumber(value[2], fallback[2])];
}

function scaleVector(value, fallback = [1, 1, 1]) {
  const v = vector3(value, fallback);
  return v.map((n) => Math.max(0.01, n));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, body, contentType = "text/html; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  const length = Math.max(left.length, right.length, 1);
  const leftPadded = Buffer.concat([left, Buffer.alloc(length - left.length)]);
  const rightPadded = Buffer.concat([right, Buffer.alloc(length - right.length)]);
  return crypto.timingSafeEqual(leftPadded, rightPadded) && left.length === right.length;
}

class H1emuWebEditorPlugin extends BasePlugin {
  constructor() {
    super();
    this.name = "h1emu-web-editor";
    this.server = null;
    this.config = { port: 8380, bindAddress: "127.0.0.1", password: "change-me", updateRateHz: 10, assetsDir: "E:/big boy stuff/FORMAT/Why2.0" };
    this.httpServer = null;
    this.wsServer = null;
    this.sessions = new Map();
    this.loginFailures = new Map();
    this.clients = new Set();
    this.entitySigs = new Map(); // id -> { v:[x,y,z,euler,scale], gen } for cheap change detection
    this.scanGen = 0;
    this.staticZoneObjects = null;
    this.savedConstructionPayloads = [];
    this.scanTimer = null;
    this.playerTimer = null;
    this.pendingTransforms = new Map();
    this.lastRespawns = new Map();
    this.savedConstructionSource = null;
    this.liveLoadRetryTimer = null;
    this.liveLoadAttempts = 0;
    this.saveWorldTimer = null;
    this._zoneServerCache = null;
    this.editorObjects = [];               // registry of placed objects the server won't save
    this.registryByCharacterId = new Map();
    this.editorObjectsSpawned = false;
  }

  loadConfig(config) {
    this.config = {
      port: Math.max(1, Math.min(65535, Number(config.port) || 8380)),
      bindAddress: String(config.bindAddress || "127.0.0.1"),
      password: String(config.password || "change-me"),
      updateRateHz: Math.max(1, Math.min(60, Number(config.updateRateHz) || 10)),
      assetsDir: String(config.assetsDir || "E:/big boy stuff/FORMAT/Why2.0"),
    };
  }

  async init(server) {
    this.server = server || this.server;
    if (!this.server) return;

    // Plugins are loaded into BOTH workers when launched via h1emu-2016.js.
    // Only the ZoneServer has a world; if the LoginServer instance starts
    // first it steals port 8380 and serves an empty, read-only editor.
    if (typeof this.server.pushToGridCell !== "function" || typeof this.server.sendData !== "function") {
      console.log("[h1emu-web-editor] Skipping init: not a ZoneServer instance (the editor runs in the zone worker only).");
      return;
    }

    if (this.server.h1emuWebEditor?.close) {
      this.server.h1emuWebEditor.close();
    }
    this.server.h1emuWebEditor = this;
    this.ensureConstructionDictionaries();

    await this.loadSavedConstructionsIfNeeded();
    this.startLiveLoadRetry();
    this.modelsCatalog(); // also fills MODEL_NAME_BY_ID so props get readable names
    this.editorObjects = this.loadRegistry();
    this.respawnEditorObjects();
    this.startHttpServer();
    this.scanTimer = setInterval(() => this.broadcastObjectChanges(), SCAN_INTERVAL_MS);
    this.playerTimer = setInterval(() => this.broadcastPlayers(), PLAYER_INTERVAL_MS);

    if (this.config.password === "change-me") {
      console.warn("[h1emu-web-editor] Default password is still 'change-me'. Change plugins/h1emu-web-editor-config.yaml before exposing this beyond localhost.");
    }
  }

  close() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.playerTimer) clearInterval(this.playerTimer);
    if (this.liveLoadRetryTimer) clearInterval(this.liveLoadRetryTimer);
    if (this.saveWorldTimer) clearTimeout(this.saveWorldTimer);
    this.scanTimer = null;
    this.playerTimer = null;
    this.liveLoadRetryTimer = null;
    this.saveWorldTimer = null;
    for (const entry of this.pendingTransforms.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.pendingTransforms.clear();
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    if (this.wsServer) this.wsServer.close();
    if (this.httpServer) this.httpServer.close();
    this.wsServer = null;
    this.httpServer = null;
  }

  async loadSavedConstructionsIfNeeded() {
    const existing = this.liveConstructionCount();
    if (existing > 0) {
      console.log(`[h1emu-web-editor] Using ${existing} live construction entities already loaded by the zone server.`);
      return;
    }

    const source = this.isMongoBackedServer() ? await this.loadWorldDataManagerConstructions("MongoDB") : await this.loadWorldDataManagerConstructions("single-player");
    const fallbackSource = !this.isMongoBackedServer() && (!source.constructions.length && !source.worldConstructions.length)
      ? this.loadSinglePlayerConstructionFiles()
      : source;
    this.savedConstructionSource = fallbackSource;
    this.savedConstructionPayloads = this.buildSavedConstructionPayloads(fallbackSource);

    if (typeof this.server?.getTransientId !== "function" || typeof this.server?.pushToGridCell !== "function") {
      console.warn(`[h1emu-web-editor] Server entity helpers are not ready. Showing ${this.savedConstructionPayloads.length} saved constructions as read-only.`);
      return;
    }

    this.loadConstructionSaveData(fallbackSource);
    const loaded = this.liveConstructionCount();
    if (loaded > 0) {
      this.savedConstructionPayloads = [];
      console.log(`[h1emu-web-editor] Saved constructions are live/editable in the running game (${loaded} entities).`);
    } else if (this.savedConstructionPayloads.length) {
      console.warn(`[h1emu-web-editor] Saved constructions could not be instantiated live. Showing ${this.savedConstructionPayloads.length} saved records as read-only.`);
    }
  }

  startLiveLoadRetry() {
    // Plugin init runs before the zone server finishes loading item definitions,
    // so the first live-instantiation attempt can fail. Keep retrying until the
    // saved constructions become live entities (or the server loads them itself).
    if (this.liveConstructionCount() > 0 || !this.savedConstructionPayloads.length) return;
    this.liveLoadRetryTimer = setInterval(() => {
      this.liveLoadAttempts++;
      if (this.liveConstructionCount() === 0 && this.savedConstructionSource &&
          typeof this.server?.getTransientId === "function" && typeof this.server?.pushToGridCell === "function") {
        this.loadConstructionSaveData(this.savedConstructionSource);
      }
      if (this.liveConstructionCount() > 0) {
        clearInterval(this.liveLoadRetryTimer);
        this.liveLoadRetryTimer = null;
        this.savedConstructionPayloads = [];
        console.log(`[h1emu-web-editor] Saved constructions are now live/editable (retry ${this.liveLoadAttempts}).`);
        this.broadcast({ type: "snapshot", objects: this.objectSnapshot() });
      } else if (this.liveLoadAttempts >= 24) {
        clearInterval(this.liveLoadRetryTimer);
        this.liveLoadRetryTimer = null;
        console.warn("[h1emu-web-editor] Could not make saved constructions live after repeated attempts; they remain read-only.");
      }
    }, 5000);
  }

  ensureConstructionDictionaries() {
    const server = this.zoneServer();
    server._constructionFoundations = server._constructionFoundations || {};
    server._constructionSimple = server._constructionSimple || {};
    server._constructionDoors = server._constructionDoors || {};
    server._lootableConstruction = server._lootableConstruction || {};
    server._worldLootableConstruction = server._worldLootableConstruction || {};
    server._worldSimpleConstruction = server._worldSimpleConstruction || {};
    server._clients = server._clients || {};
    server._grid = server._grid || [];
  }

  isMongoBackedServer() {
    return Boolean(this.server?._mongoAddress) || this.server?.worldDataManager?._soloMode === false;
  }

  async loadWorldDataManagerConstructions(sourceName) {
    const manager = this.server?.worldDataManager;
    if (!manager || typeof manager.loadConstructionData !== "function" || typeof manager.loadWorldFreeplaceConstruction !== "function") {
      if (sourceName === "MongoDB") return this.loadMongoConstructionData();
      return { sourceName, constructions: [], worldConstructions: [] };
    }
    try {
      const [constructions, worldConstructions] = await Promise.all([
        manager.loadConstructionData(),
        manager.loadWorldFreeplaceConstruction(),
      ]);
      return {
        sourceName,
        constructions: Array.isArray(constructions) ? constructions : [],
        worldConstructions: Array.isArray(worldConstructions) ? worldConstructions : [],
      };
    } catch (err) {
      console.warn(`[h1emu-web-editor] Could not read ${sourceName} construction data through WorldDataManager: ${err.message}`);
      if (sourceName === "MongoDB") return this.loadMongoConstructionData();
      return { sourceName, constructions: [], worldConstructions: [] };
    }
  }

  async loadMongoConstructionData() {
    const db = this.server?._db;
    const serverId = this.server?._worldId;
    if (!db || serverId === undefined) return { sourceName: "MongoDB", constructions: [], worldConstructions: [] };
    try {
      const [constructions, worldConstructions] = await Promise.all([
        db.collection(DB_COLLECTIONS.CONSTRUCTION).find({ serverId }).toArray(),
        db.collection(DB_COLLECTIONS.WORLD_CONSTRUCTIONS).find({ serverId }).toArray(),
      ]);
      return {
        sourceName: "MongoDB direct collections",
        constructions: Array.isArray(constructions) ? constructions : [],
        worldConstructions: Array.isArray(worldConstructions) ? worldConstructions : [],
      };
    } catch (err) {
      console.warn(`[h1emu-web-editor] Could not read MongoDB construction collections: ${err.message}`);
      return { sourceName: "MongoDB", constructions: [], worldConstructions: [] };
    }
  }

  loadSinglePlayerConstructionFiles() {
    const worldDataPath = path.join(getAppDataFolderPath(), "worlddata");
    return {
      sourceName: `single-player files at ${worldDataPath}`,
      constructions: this.readJsonArray(path.join(worldDataPath, "construction.json")),
      worldConstructions: this.readJsonArray(path.join(worldDataPath, "worldconstruction.json")),
    };
  }

  loadConstructionSaveData(source) {
    if (!source.constructions.length && !source.worldConstructions.length) {
      console.warn(`[h1emu-web-editor] No saved constructions found in ${source.sourceName}.`);
      return;
    }
    try {
      const server = this.zoneServer();
      WorldDataManager.loadConstructionParentEntities(source.constructions, server);
      for (const entityData of source.worldConstructions) {
        WorldDataManager.loadLootableConstructionEntity(server, entityData, true);
      }
      console.log(
        `[h1emu-web-editor] Loaded ${this.liveConstructionCount()} saved constructions from ${source.sourceName} ` +
        `(${source.constructions.length} parent records, ${source.worldConstructions.length} world records).`
      );
    } catch (err) {
      console.error(`[h1emu-web-editor] Failed to load saved constructions from ${source.sourceName}: ${err.message}`);
    }
  }

  buildSavedConstructionPayloads(source) {
    const objects = [];
    for (const parent of source.constructions || []) this.flattenSavedConstruction(parent, "foundation", objects);
    for (const freeplace of source.worldConstructions || []) this.flattenSavedConstruction(freeplace, "worldLootable", objects);
    return objects.map((obj) => ({ ...obj, sourceName: source.sourceName }));
  }

  flattenSavedConstruction(entityData, kind, objects) {
    if (!entityData?.characterId || !entityData?.position) return;
    const modelId = entityData.actorModelId || entityData.modelId || 0;
    const itemDefId = entityData.itemDefinitionId || 0;
    objects.push({
      id: String(entityData.characterId),
      kind,
      modelId,
      itemDefId,
      name: ITEM_NAME_BY_ID[itemDefId] || MODEL_NAME_BY_ID[modelId] || `${kind} ${itemDefId || modelId || "unknown"}`,
      pos: vector3(entityData.position),
      rot: entityData.rotation ? Array.from(entityData.rotation).slice(0, 4).map((n) => toNumber(n)) : [0, toNumber(entityData.eulerAngle), 0, 0],
      // Door/gate records store their yaw in rotation[0]; everything else uses eulerAngle.
      euler: kind === "door" ? toNumber(entityData.rotation?.[0]) : toNumber(entityData.eulerAngle, toNumber(entityData.rotation?.[1])),
      scale: scaleVector(entityData.scale || [1, 1, 1]),
      editable: false,
      source: "saved",
    });

    for (const child of Object.values(entityData.occupiedWallSlots || {})) {
      this.flattenSavedConstruction(child, child?.passwordHash !== undefined ? "door" : "simple", objects);
    }
    for (const child of Object.values(entityData.occupiedUpperWallSlots || {})) this.flattenSavedConstruction(child, "simple", objects);
    for (const child of Object.values(entityData.occupiedShelterSlots || {})) this.flattenSavedConstruction(child, "simple", objects);
    for (const child of Object.values(entityData.occupiedRampSlots || {})) this.flattenSavedConstruction(child, "simple", objects);
    for (const child of Object.values(entityData.occupiedExpansionSlots || {})) this.flattenSavedConstruction(child, "foundation", objects);
    for (const child of Object.values(entityData.freeplaceEntities || {})) {
      this.flattenSavedConstruction(child, child?.passwordHash !== undefined ? "door" : child?.container ? "lootable" : "simple", objects);
    }
  }

  liveConstructionCount() {
    const server = this.zoneServer();
    return this.countConstructionDictionaries(server);
  }

  countConstructionDictionaries(server) {
    return [
      server?._constructionFoundations,
      server?._constructionSimple,
      server?._constructionDoors,
      server?._lootableConstruction,
      server?._worldLootableConstruction,
      server?._worldSimpleConstruction,
    ].reduce((sum, dict) => sum + Object.keys(dict || {}).length, 0);
  }

  readJsonArray(filePath) {
    try {
      if (!fs.existsSync(filePath)) return [];
      const data = JSON.parse(fs.readFileSync(filePath, "utf8") || "[]");
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn(`[h1emu-web-editor] Could not read ${filePath}: ${err.message}`);
      return [];
    }
  }

  startHttpServer() {
    const publicDir = path.join(this.dir || __dirname, "public");
    const loginHtml = fs.readFileSync(path.join(publicDir, "login.html"), "utf8");
    const appHtml = fs.readFileSync(path.join(publicDir, "app.html"), "utf8");

    this.httpServer = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res, loginHtml, appHtml);
    });
    this.wsServer = new WebSocketServer({ noServer: true });
    this.httpServer.on("upgrade", (req, socket, head) => {
      this.wsServer.handleUpgrade(req, socket, head, (ws) => this.handleWebSocket(ws, req));
    });
    this.httpServer.listen(this.config.port, this.config.bindAddress, () => {
      console.log(`[h1emu-web-editor] Listening on http://${this.config.bindAddress}:${this.config.port}`);
    });
    this.httpServer.on("error", (err) => {
      console.error(`[h1emu-web-editor] HTTP server error: ${err.message}`);
    });
  }

  async handleHttpRequest(req, res, loginHtml, appHtml) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "POST" && url.pathname === "/api/login") {
      await this.handleLogin(req, res);
      return;
    }

    if ((url.pathname === "/" || url.pathname === "/login") && req.method === "GET") {
      sendText(res, 200, loginHtml);
      return;
    }

    const session = this.authenticateRequest(req);
    if (!session) {
      sendJson(res, 401, { message: "Unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/app") {
      sendText(res, 200, appHtml);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/snapshot") {
      sendJson(res, 200, { type: "snapshot", objects: this.objectSnapshot(), players: this.playerSnapshot() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/placeables") {
      sendJson(res, 200, { items: this.placeableCatalog(), models: this.modelsCatalog() });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/model-mesh/")) {
      this.serveModelMesh(res, Number(url.pathname.slice("/api/model-mesh/".length)) || 0);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/model-texture/")) {
      this.serveModelTexture(res, decodeURIComponent(url.pathname.slice("/api/model-texture/".length)));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/presets") {
      sendJson(res, 200, { presets: this.listPresets() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/debug/objects") {
      sendJson(res, 200, this.objectDebugPayload());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/map-image") {
      this.serveMapImage(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/terrain") {
      this.serveTerrainBinary(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/terrain-params") {
      this.serveTerrainParams(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/zone-objects") {
      this.serveStaticBinary(req, res, "zone-objects.bin", "Run zone-objects-to-bin.js first.");
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/speedtrees") {
      this.serveSpeedTrees(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/world-models") {
      this.serveStaticBinary(req, res, "world-models.bin", "Run actors-to-models.js first.");
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/world-texture/")) {
      const texName = decodeURIComponent(url.pathname.slice("/api/world-texture/".length));
      if (!texName || texName.includes("..") || texName.includes("/") || texName.includes("\\")) {
        sendJson(res, 400, { message: "Invalid texture name." });
        return;
      }
      this.serveStaticBinary(req, res, path.join("world-textures", texName), "Run actors-to-models.js first.", "public, max-age=3600");
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/terrain-texture/")) {
      const texName = decodeURIComponent(url.pathname.slice("/api/terrain-texture/".length));
      this.serveTerrainTexture(req, res, texName);
      return;
    }

    sendJson(res, 404, { message: "Not found" });
  }

  async handleLogin(req, res) {
    const ip = this.requestIp(req);
    const failure = this.loginFailures.get(ip);
    if (failure?.blockedUntil && failure.blockedUntil > Date.now()) {
      sendJson(res, 429, { message: "Too many failed logins. Try again later." });
      return;
    }

    let body;
    try {
      body = await this.readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { message: err.message || "Bad request" });
      return;
    }

    if (!constantTimeEqual(body.password, this.config.password)) {
      const next = { count: (failure?.count || 0) + 1, blockedUntil: 0 };
      if (next.count >= MAX_LOGIN_FAILURES) next.blockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
      this.loginFailures.set(ip, next);
      console.warn(`[h1emu-web-editor] Failed login from ${ip}${next.blockedUntil ? " (locked out)" : ""}`);
      sendJson(res, next.blockedUntil ? 429 : 401, { message: "Invalid password" });
      return;
    }

    this.loginFailures.delete(ip);
    const token = crypto.randomBytes(16).toString("hex");
    this.sessions.set(token, { token, ip, lastUsed: Date.now() });
    sendJson(res, 200, { token, expiresInSeconds: Math.floor(SESSION_IDLE_MS / 1000) });
  }

  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
        if (Buffer.byteLength(data) > BODY_LIMIT_BYTES) {
          reject(new Error("Request too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(data || "{}"));
        } catch (_) {
          reject(new Error("Invalid JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  authenticateRequest(req) {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return null;
    return this.authenticateToken(header.slice(7).trim());
  }

  authenticateToken(token) {
    const session = this.sessions.get(String(token || ""));
    if (!session) return null;
    if (Date.now() - session.lastUsed > SESSION_IDLE_MS) {
      this.sessions.delete(session.token);
      return null;
    }
    session.lastUsed = Date.now();
    return session;
  }

  requestIp(req) {
    return String(req.socket?.remoteAddress || "unknown");
  }

  serveMapImage(res) {
    const mapPath = path.join(this.dir || __dirname, "..", "h1emu-ui-example", "server_manager_map.png");
    if (!fs.existsSync(mapPath)) {
      sendJson(res, 404, { message: "Missing server_manager_map.png" });
      return;
    }
    const stat = fs.statSync(mapPath);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(mapPath).pipe(res);
  }

  serveTerrainBinary(req, res) {
    const terrainPath = path.join(this.dir || __dirname, "public", "terrain", "terrain.bin");
    if (!fs.existsSync(terrainPath)) {
      sendJson(res, 404, { message: "No terrain data. Run cnk-to-obj.py first." });
      return;
    }
    this.sendFileCached(req, res, terrainPath, "public, no-cache");
  }

  serveStaticBinary(req, res, fileName, hint, cacheControl = "public, no-cache") {
    const binPath = path.join(this.dir || __dirname, "public", "terrain", fileName);
    if (!fs.existsSync(binPath)) {
      sendJson(res, 404, { message: `No ${fileName}. ${hint}` });
      return;
    }
    this.sendFileCached(req, res, binPath, cacheControl);
  }

  // Serves with Last-Modified so browsers revalidate and get a 304 instead of
  // re-downloading unchanged multi-hundred-MB payloads on every reload.
  sendFileCached(req, res, filePath, cacheControl) {
    const stat = fs.statSync(filePath);
    const lastModified = new Date(stat.mtimeMs).toUTCString();
    if (req.headers["if-modified-since"] === lastModified) {
      res.writeHead(304, { "Last-Modified": lastModified, "Cache-Control": cacheControl });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size,
      "Last-Modified": lastModified,
      "Cache-Control": cacheControl,
    });
    fs.createReadStream(filePath).pipe(res);
  }

  serveSpeedTrees(res) {
    if (!this.speedTreeBuffer) {
      const treeList = this.loadZoneData("Z1_speedTrees.json");
      const buf = Buffer.alloc(8 + treeList.length * 16);
      buf.write("TRE1", 0);
      buf.writeUInt32LE(treeList.length, 4);
      let off = 8;
      for (const tree of treeList) {
        const p = tree.position || [0, 0, 0];
        buf.writeFloatLE(toNumber(p[0]), off);
        buf.writeFloatLE(toNumber(p[1]), off + 4);
        buf.writeFloatLE(toNumber(p[2]), off + 8);
        buf.writeUInt32LE(toNumber(tree.id), off + 12);
        off += 16;
      }
      this.speedTreeBuffer = buf;
      console.log(`[h1emu-web-editor] Prepared ${treeList.length} speed trees for the 3D editor.`);
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": this.speedTreeBuffer.length,
      "Cache-Control": "public, max-age=3600",
    });
    res.end(this.speedTreeBuffer);
  }

  serveTerrainParams(res) {
    const paramsPath = path.join(this.dir || __dirname, "public", "terrain", "terrain-params.json");
    if (!fs.existsSync(paramsPath)) {
      sendJson(res, 404, { message: "No terrain params." });
      return;
    }
    const params = JSON.parse(fs.readFileSync(paramsPath, "utf8"));
    sendJson(res, 200, params);
  }

  serveTerrainTexture(req, res, texName) {
    if (!texName || texName.includes("..")) {
      sendJson(res, 400, { message: "Invalid texture name." });
      return;
    }
    // Prefer the mip-capped copies (shrink-terrain-textures.js) — ~4x smaller.
    const smallPath = path.join(this.dir || __dirname, "public", "terrain", "textures-small", texName);
    const fullPath = path.join(this.dir || __dirname, "public", "terrain", "textures", texName);
    const texPath = fs.existsSync(smallPath) ? smallPath : fullPath;
    if (!fs.existsSync(texPath)) {
      sendJson(res, 404, { message: "Texture not found." });
      return;
    }
    this.sendFileCached(req, res, texPath, "public, max-age=3600");
  }

  handleWebSocket(ws, req) {
    ws.isAuthed = false;
    ws.requestIp = this.requestIp(req);
    const timer = setTimeout(() => {
      if (!ws.isAuthed) ws.close(1008, "auth timeout");
    }, AUTH_MESSAGE_TIMEOUT_MS);

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch (_) {
        ws.close(1003, "invalid json");
        return;
      }

      if (!ws.isAuthed) {
        if (msg.type !== "auth" || !this.authenticateToken(msg.token)) {
          ws.close(1008, "unauthorized");
          return;
        }
        clearTimeout(timer);
        ws.isAuthed = true;
        this.clients.add(ws);
        this.sendWs(ws, { type: "auth_ok" });
        this.sendWs(ws, { type: "snapshot", objects: this.objectSnapshot() });
        this.sendWs(ws, { type: "players", players: this.playerSnapshot() });
        return;
      }

      this.handleEditorMessage(ws, msg);
    });
    ws.on("close", () => {
      clearTimeout(timer);
      this.clients.delete(ws);
    });
  }

  handleEditorMessage(ws, msg) {
    if (msg.type === "transform") {
      const ok = this.queueTransform(msg);
      if (!ok) this.sendWs(ws, { type: "error", message: "Transform failed" });
      return;
    }
    if (msg.type === "transformBatch") {
      // Whole multi-selection applied atomically (see applyTransformBatch).
      const ok = this.applyTransformBatch(msg.items, Boolean(msg.final));
      if (!ok) this.sendWs(ws, { type: "error", message: "Batch transform failed" });
      return;
    }
    if (msg.type === "place") {
      const payload = this.placeObject(msg);
      if (payload) this.sendWs(ws, { type: "placed", object: payload });
      else this.sendWs(ws, { type: "error", message: "Could not place that object" });
      return;
    }
    if (msg.type === "delete") {
      const ok = this.deleteObject(msg.id);
      if (!ok) this.sendWs(ws, { type: "error", message: "Could not delete that object" });
      return;
    }
    if (msg.type === "savePreset") {
      const preset = this.savePreset(msg);
      if (preset) this.broadcast({ type: "presets", presets: this.listPresets() });
      else this.sendWs(ws, { type: "error", message: "Could not save preset" });
      return;
    }
    if (msg.type === "deletePreset") {
      if (this.deletePreset(msg.name)) this.broadcast({ type: "presets", presets: this.listPresets() });
      else this.sendWs(ws, { type: "error", message: "Could not delete preset" });
      return;
    }
    if (msg.type === "spawnPreset") {
      if (!this.spawnPreset(msg)) this.sendWs(ws, { type: "error", message: "Could not spawn preset" });
      return;
    }
    this.sendWs(ws, { type: "error", message: `Unsupported message type: ${msg.type}` });
  }

  sendWs(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  broadcast(payload) {
    const body = JSON.stringify(payload);
    for (const ws of this.clients) {
      if (ws.isAuthed && ws.readyState === WebSocket.OPEN) ws.send(body);
    }
  }

  placedObjectDictionaries() {
    const server = this.zoneServer();
    return [
      ["foundation", server?._constructionFoundations],
      ["simple", server?._constructionSimple],
      ["door", server?._constructionDoors],
      ["lootable", server?._lootableConstruction],
      ["worldLootable", server?._worldLootableConstruction],
      ["worldSimple", server?._worldSimpleConstruction],
      ["lootableProp", server?._lootableProps],
      ["taskProp", server?._taskProps],
      ["crate", server?._crates],
      ["destroyable", server?._destroyables],
      ["worldDoor", server?._doors],
      ["vehicle", server?._vehicles],
      ["npc", server?._npcs],
      ["spawnedItem", server?._spawnedItems],
      ["lootbag", server?._lootbags],
      ["trap", server?._traps],
      ["explosive", server?._explosives],
      ["temporary", server?._temporaryObjects],
    ].filter(([, dict]) => dict && typeof dict === "object");
  }

  zoneServer() {
    // Cache the resolved server. Resolving calls countConstructionDictionaries,
    // which does Object.keys() over the 34k-entry construction maps — doing that
    // repeatedly (it was called several times per moved piece) was the dominant
    // cost when dragging a whole foundation. Cache once constructions exist.
    if (this._zoneServerCache) return this._zoneServerCache;
    const plugins = this.server?.pluginManager?.plugins || [];
    const examplePlugin = plugins.find((plugin) => plugin?.name === "h1emu-ui-example" && plugin.server && this.countConstructionDictionaries(plugin.server) > 0);
    if (examplePlugin?.server) return (this._zoneServerCache = examplePlugin.server);
    if (this.countConstructionDictionaries(this.server) > 0) return (this._zoneServerCache = this.server);
    return this.server; // not cached until constructions are loaded
  }

  placedObjects() {
    const objects = [];
    for (const [kind, dict] of this.placedObjectDictionaries()) {
      for (const [id, entity] of Object.entries(dict || {})) {
        const position = this.entityPosition(entity);
        if (!entity || !position) continue;
        if (!entity.characterId) entity.characterId = id;
        objects.push({ kind, entity, id: entity.characterId || id });
      }
    }
    return objects;
  }

  findPlacedObject(id) {
    const wanted = String(id || "");
    if (!wanted) return null;
    const dicts = this.placedObjectDictionaries();
    // Direct key lookup across the entity dictionaries (they're keyed by
    // characterId) — O(#dicts) instead of scanning all ~85k entities. Moving a
    // foundation looks up ~166 children, so the old scan was the main lag source.
    for (const [kind, dict] of dicts) {
      const entity = dict[wanted];
      if (entity) {
        if (!entity.characterId) entity.characterId = wanted;
        return { kind, entity, id: entity.characterId || wanted };
      }
    }
    // Fallback (rare): entity stored under a key other than its characterId.
    for (const [kind, dict] of dicts) {
      for (const key in dict) {
        const entity = dict[key];
        if (entity && String(entity.characterId) === wanted) return { kind, entity, id: wanted };
      }
    }
    return null;
  }

  entitySig(entity) {
    const p = this.entityPosition(entity);
    if (!p) return null;
    const euler = this.entityYaw(entity);
    const scale = toNumber(entity.scale && entity.scale[0], 1);
    return [toNumber(p[0]), toNumber(p[1]), toNumber(p[2]), euler, scale];
  }

  objectSnapshot() {
    const entries = this.placedObjects();
    const liveObjects = entries.map((entry) => this.objectPayload(entry));
    if (!liveObjects.length && this.savedConstructionPayloads.length) return this.savedConstructionPayloads;
    // Seed the change-detection baseline so the next periodic scan starts clean.
    const gen = ++this.scanGen;
    this.entitySigs = new Map();
    for (const entry of entries) {
      const v = this.entitySig(entry.entity);
      if (v) this.entitySigs.set(String(entry.id), { v, gen });
    }
    return liveObjects;
  }

  objectDebugPayload() {
    const objects = this.placedObjects().map((entry) => this.objectPayload(entry));
    const byKind = {};
    for (const obj of objects) byKind[obj.kind] = (byKind[obj.kind] || 0) + 1;
    const dictionaries = {};
    for (const [kind, dict] of this.placedObjectDictionaries()) {
      const values = Object.values(dict || {});
      dictionaries[kind] = {
        entries: values.length,
        withPosition: values.filter((entity) => this.entityPosition(entity)).length,
        withCharacterId: values.filter((entity) => entity?.characterId).length,
      };
    }
    const examplePlugin = (this.server?.pluginManager?.plugins || []).find((plugin) => plugin?.name === "h1emu-ui-example" && plugin.server);
    return {
      serverResolution: {
        directConstructionCount: this.countConstructionDictionaries(this.server),
        examplePluginConstructionCount: this.countConstructionDictionaries(examplePlugin?.server),
        resolvedConstructionCount: this.countConstructionDictionaries(this.zoneServer()),
        hasExamplePluginServer: Boolean((this.server?.pluginManager?.plugins || []).find((plugin) => plugin?.name === "h1emu-ui-example" && plugin.server)),
      },
      liveConstructionCount: this.liveConstructionCount(),
      placedObjectsCount: objects.length,
      savedFallbackCount: this.savedConstructionPayloads.length,
      dictionaries,
      byKind,
      savedSamples: this.savedConstructionPayloads.slice(0, 20),
      samples: objects.slice(0, 20),
    };
  }

  objectPayload(entry) {
    const entity = entry.entity;
    const pos = vector3(this.entityPosition(entity));
    const rotation = this.entityRotation(entity);
    const rot = rotation ? Array.from(rotation).slice(0, 4).map((n) => toNumber(n)) : [0, 0, 0, 0];
    const scale = scaleVector(entity.scale || [1, 1, 1]);
    const modelId = entity.actorModelId || entity.modelId || 0;
    const itemDefId = entity.itemDefinitionId || entity.item?.itemDefinitionId || 0;
    const name = ITEM_NAME_BY_ID[itemDefId] || MODEL_NAME_BY_ID[modelId] || entity.name || `${entry.kind} ${itemDefId || modelId || "unknown"}`;
    return {
      id: String(entry.id || entity.characterId),
      kind: entry.kind,
      modelId,
      itemDefId,
      name,
      pos,
      rot,
      euler: this.entityYaw(entity),
      scale,
      editable: true,
      source: "live",
    };
  }

  entityPosition(entity) {
    return entity?.state?.position || entity?.position || entity?.fixedPosition || null;
  }

  entityRotation(entity) {
    return entity?.state?.rotation || entity?.rotation || null;
  }

  // World yaw of an entity. Construction parents/children keep it in eulerAngle
  // (== rotation[1]). Doors/gates (DoorEntity) instead keep it in startRot[0]
  // (their closedAngle) and store state.rotation as a QUATERNION — so reading
  // rotation[1] for them yields a quaternion component, not an angle.
  entityYaw(entity) {
    if (entity?.eulerAngle !== undefined) return toNumber(entity.eulerAngle);
    if (entity?.startRot) return toNumber(entity.startRot[0]);
    if (entity?.closedAngle !== undefined) return toNumber(entity.closedAngle);
    const rot = this.entityRotation(entity);
    return toNumber(rot && rot[1]);
  }

  filteredStaticZoneObjects(liveObjects) {
    const liveKinds = new Set(liveObjects.map((obj) => obj.kind));
    return this.staticZoneObjectPayloads().filter((obj) => {
      if (obj.kind === "itemSpawner" || obj.kind === "npcSpawner" || obj.kind === "vehicleSpawner" || obj.kind === "speedTree" || obj.kind === "staticProp") return true;
      return !liveKinds.has(obj.kind);
    });
  }

  staticZoneObjectPayloads() {
    if (this.staticZoneObjects) return this.staticZoneObjects;
    const objects = [];
    const addGrouped = (kind, fileName) => {
      const groups = this.loadZoneData(fileName);
      groups.forEach((group, groupIndex) => {
        for (const [instanceIndex, instance] of Object.entries(group.instances || [])) {
          objects.push(this.staticZoneObjectPayload(kind, group, instance, `${groupIndex}:${instance.id || instance.zoneId || instanceIndex}`));
        }
      });
    };
    const addFlat = (kind, fileName) => {
      this.loadZoneData(fileName).forEach((instance, index) => {
        objects.push(this.staticZoneObjectPayload(kind, instance, instance, `${instance.id || instance.uniqueId || index}`));
      });
    };

    addGrouped("staticProp", "Z1_props.json");
    addGrouped("lootableProp", "Z1_lootableProps.json");
    addGrouped("taskProp", "Z1_taskProps.json");
    addGrouped("crate", "Z1_crates.json");
    addGrouped("worldDoor", "Z1_doors.json");
    addGrouped("destroyable", "Z1_destroyables.json");
    addGrouped("itemSpawner", "Z1_items.json");
    addGrouped("npcSpawner", "Z1_npcs.json");
    addFlat("vehicleSpawner", "Z1_vehicleLocations.json");
    addFlat("speedTree", "Z1_speedTrees.json");

    this.staticZoneObjects = objects.filter((obj) => obj.pos.some((n) => Number.isFinite(n)));
    console.log(`[h1emu-web-editor] Loaded ${this.staticZoneObjects.length} static zone objects for 3D editor.`);
    return this.staticZoneObjects;
  }

  loadZoneData(fileName) {
    try {
      return PluginManager.loadServerData(`2016/zoneData/${fileName}`) || [];
    } catch (err) {
      console.warn(`[h1emu-web-editor] Could not load ${fileName}: ${err.message}`);
      return [];
    }
  }

  staticZoneObjectPayload(kind, group, instance, suffix) {
    const pos = vector3(instance.position);
    const rot = instance.rotation ? Array.from(instance.rotation).slice(0, 4).map((n) => toNumber(n)) : [0, 0, 0, 0];
    const modelId = instance.modelId || group.modelId || instance.vehicleId || group.vehicleId || instance.id || 0;
    const scale = scaleVector(instance.scale || group.scale || this.defaultStaticScale(kind));
    return {
      id: `static:${kind}:${suffix}`,
      kind,
      modelId,
      itemDefId: 0,
      name: group.name || group.actorDefinition || `${kind} ${modelId || suffix}`,
      pos,
      rot,
      euler: toNumber(instance.orientation, toNumber(rot[1], toNumber(rot[0]))),
      scale,
      editable: false,
      source: "zoneData",
    };
  }

  defaultStaticScale(kind) {
    if (kind === "itemSpawner") return [0.4, 0.4, 0.4];
    if (kind === "npcSpawner") return [0.7, 1.8, 0.7];
    if (kind === "vehicleSpawner") return [2.2, 1.2, 4.0];
    if (kind === "speedTree") return [1.0, 4.0, 1.0];
    return [1, 1, 1];
  }

  broadcastObjectChanges() {
    if (!this.clients.size) return;
    // Cheap numeric diff over live entities: no payload allocation or string
    // hashing for the ~85k unchanged objects, only for the few that moved.
    // (The old full-payload+hash scan blocked the event loop ~250ms/tick and
    // starved terrain/model downloads.)
    const gen = ++this.scanGen;
    const changed = [];
    const EPS = 1e-3, EPS_ROT = 1e-4;
    for (const [kind, dict] of this.placedObjectDictionaries()) {
      if (!dict) continue;
      for (const id in dict) {
        const entity = dict[id];
        const p = entity && this.entityPosition(entity);
        if (!p) continue;
        const cid = String(entity.characterId || id);
        const px = toNumber(p[0]), py = toNumber(p[1]), pz = toNumber(p[2]);
        const euler = this.entityYaw(entity);
        const scl = toNumber(entity.scale && entity.scale[0], 1);
        const rec = this.entitySigs.get(cid);
        if (!rec) {
          this.entitySigs.set(cid, { v: [px, py, pz, euler, scl], gen });
          changed.push(this.objectPayload({ kind, entity, id: cid }));
        } else {
          const v = rec.v;
          if (Math.abs(v[0] - px) > EPS || Math.abs(v[1] - py) > EPS || Math.abs(v[2] - pz) > EPS ||
              Math.abs(v[3] - euler) > EPS_ROT || Math.abs(v[4] - scl) > EPS) {
            v[0] = px; v[1] = py; v[2] = pz; v[3] = euler; v[4] = scl;
            changed.push(this.objectPayload({ kind, entity, id: cid }));
          }
          rec.gen = gen;
        }
      }
    }
    const removed = [];
    for (const [id, rec] of this.entitySigs) {
      if (rec.gen !== gen) { removed.push(id); this.entitySigs.delete(id); }
    }
    if (changed.length) this.broadcast({ type: "update", objects: changed });
    if (removed.length) this.broadcast({ type: "removed", ids: removed });
  }

  playerSnapshot() {
    return Object.values(this.zoneServer()?._clients || {})
      .filter((client) => client?.character?.state?.position)
      .map((client) => ({
        name: this.playerName(client),
        pos: vector3(client.character.state.position),
      }));
  }

  playerName(client) {
    return String(client?.character?.name || client?.character?.characterName || client?.loginSessionId || "Player").replace(/[\n\r]/g, " ");
  }

  broadcastPlayers() {
    if (this.clients.size) this.broadcast({ type: "players", players: this.playerSnapshot() });
  }

  queueTransform(msg) {
    const entry = this.findPlacedObject(msg.id);
    if (!entry) return false;
    const entity = entry.entity;
    const transform = {
      id: String(entry.id || entity.characterId),
      pos: msg.pos ? vector3(msg.pos, vector3(this.entityPosition(entity))) : vector3(this.entityPosition(entity)),
      euler: msg.euler === undefined ? this.entityYaw(entity) : toNumber(msg.euler),
      scale: msg.scale ? scaleVector(msg.scale, scaleVector(entity.scale || [1, 1, 1])) : scaleVector(entity.scale || [1, 1, 1]),
    };

    const minIntervalMs = 1000 / this.config.updateRateHz;
    const last = this.lastRespawns.get(transform.id) || 0;
    const elapsed = Date.now() - last;
    const pending = this.pendingTransforms.get(transform.id);
    if (pending?.timer) clearTimeout(pending.timer);

    if (msg.final || elapsed >= minIntervalMs) {
      this.pendingTransforms.delete(transform.id);
      return this.applyTransform(transform, Boolean(msg.final));
    }

    const timer = setTimeout(() => {
      const next = this.pendingTransforms.get(transform.id);
      this.pendingTransforms.delete(transform.id);
      if (next) this.applyTransform(next.transform, false);
    }, Math.max(1, minIntervalMs - elapsed));
    this.pendingTransforms.set(transform.id, { transform, timer });
    return true;
  }

  applyTransform(transform, persist = false) {
    return this.applyTransformBatch([transform], persist);
  }

  resolveTransformItem(item) {
    const entry = this.findPlacedObject(item?.id);
    if (!entry) return null;
    const entity = entry.entity;
    return [entry, {
      id: String(entry.id || entity.characterId),
      pos: item.pos ? vector3(item.pos, vector3(this.entityPosition(entity))) : vector3(this.entityPosition(entity)),
      euler: item.euler === undefined ? this.entityYaw(entity) : toNumber(item.euler),
      scale: item.scale ? scaleVector(item.scale, scaleVector(entity.scale || [1, 1, 1])) : scaleVector(entity.scale || [1, 1, 1]),
    }];
  }

  // Applies a whole selection at once. Resolving every explicit target BEFORE
  // moving anything keeps this order-independent: a foundation only drags the
  // attached pieces the editor isn't already moving itself, so a piece that is
  // both selected and attached can't get its delta applied twice.
  applyTransformBatch(items, persist = false) {
    const explicit = [];
    const explicitIds = new Set();
    for (const item of items || []) {
      const resolved = this.resolveTransformItem(item);
      if (!resolved) continue;
      explicit.push(resolved);
      explicitIds.add(resolved[1].id);
    }
    if (!explicit.length) return false;

    const applied = explicit.slice();
    for (const [entry, transform] of explicit) {
      if (entry.kind !== "foundation") continue;
      const entity = entry.entity;
      const oldPos = vector3(this.entityPosition(entity));
      const dYaw = transform.euler - this.entityYaw(entity);
      const cos = Math.cos(dYaw), sin = Math.sin(dYaw);
      for (const child of this.constructionChildren(entity)) {
        const cid = String(child.characterId);
        if (explicitIds.has(cid)) continue; // moved explicitly — don't drag it too
        const childEntry = this.findPlacedObject(cid);
        if (!childEntry || childEntry.entity === entity) continue;
        const cp = vector3(this.entityPosition(child));
        const ox = cp[0] - oldPos[0], oy = cp[1] - oldPos[1], oz = cp[2] - oldPos[2];
        applied.push([childEntry, {
          id: cid,
          pos: [transform.pos[0] + cos * ox + sin * oz, transform.pos[1] + oy, transform.pos[2] - sin * ox + cos * oz],
          euler: this.entityYaw(child) + dYaw,
          scale: scaleVector(child.scale || [1, 1, 1]),
        }]);
      }
    }

    this.commitTransforms(applied, persist);
    return true;
  }

  commitTransforms(applied, persist) {
    // One entry per entity (an explicit transform wins over a dragged one).
    const byEntity = new Map();
    for (const [entry, transform] of applied) byEntity.set(entry.entity, [entry, transform]);
    const list = [...byEntity.values()];

    const server = this.zoneServer();
    // Despawn everything, remove the whole group from the grid in ONE pass
    // (not once-per-entity over all ~1089 cells), then re-place and respawn.
    for (const [entry] of list) this.despawnPlacedEntity(entry.entity);
    this.removeEntitiesFromGrid(new Set(list.map(([e]) => e.entity)), server);
    const now = Date.now();
    let registryTouched = false;
    for (const [entry, transform] of list) {
      this.mutateEntityOnly(entry, transform);
      if (typeof server?.pushToGridCell === "function") server.pushToGridCell(entry.entity);
      this.spawnPlacedEntity(entry);
      this.lastRespawns.set(transform.id, now);
      const record = this.registryByCharacterId.get(String(entry.entity.characterId));
      if (record) {
        record.pos = [transform.pos[0], transform.pos[1], transform.pos[2]];
        record.euler = transform.euler;
        record.scale = transform.scale[0];
        registryTouched = true;
      }
    }
    if (registryTouched) this.persistRegistry();
    if (persist) this.persistConstructionTransforms(list);
    this.broadcast({ type: "update", objects: list.map(([entry]) => this.objectPayload(entry)) });
  }

  // ---------- builder mode ----------

  // The item -> placed-model mapping isn't in the item definitions (their
  // MODEL_NAME is the inventory icon model). The live world is the ground
  // truth, so derive the palette from the constructions actually loaded.
  placeableCatalog() {
    if (this._placeables) return this._placeables;
    const out = new Map();
    for (const [kind, dict] of this.constructionDictionaries()) {
      for (const entity of Object.values(dict || {})) {
        const itemDefId = Number(entity?.itemDefinitionId) || 0;
        const modelId = Number(entity?.actorModelId) || 0;
        if (!itemDefId || !modelId || out.has(itemDefId)) continue;
        out.set(itemDefId, { itemDefId, modelId, kind, name: ITEM_NAME_BY_ID[itemDefId] || MODEL_NAME_BY_ID[modelId] || `item ${itemDefId}` });
      }
    }
    this._placeables = [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
    return this._placeables;
  }

  // Every model from Models.json whose .adr exists in the assets dump — these
  // are placeable as decorative props (simple constructions with no item id).
  modelsCatalog() {
    if (this._modelsCatalog) return this._modelsCatalog;
    const out = [];
    try {
      const models = JSON.parse(fs.readFileSync(path.join(h1z1ServerRoot, "data", "2016", "dataSources", "Models.json"), "utf8"));
      for (const m of models) {
        const file = String(m.MODEL_FILE_NAME || "");
        if (!file.toLowerCase().endsWith(".adr")) continue;
        if (!fs.existsSync(path.join(this.config.assetsDir, file))) continue;
        const name = file.replace(/\.adr$/i, "");
        out.push({ modelId: Number(m.ID), name, desc: String(m.DESCRIPTION || "") });
        if (!MODEL_NAME_BY_ID[m.ID]) MODEL_NAME_BY_ID[m.ID] = name;
      }
    } catch (err) {
      console.warn(`[h1emu-web-editor] Could not build models catalog: ${err.message}`);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    this._modelsCatalog = out;
    console.log(`[h1emu-web-editor] Models catalog: ${out.length} placeable models from Models.json.`);
    return out;
  }

  modelFileById(modelId) {
    if (!this._modelFileById) {
      this._modelFileById = new Map();
      try {
        const models = JSON.parse(fs.readFileSync(path.join(h1z1ServerRoot, "data", "2016", "dataSources", "Models.json"), "utf8"));
        for (const m of models) this._modelFileById.set(Number(m.ID), String(m.MODEL_FILE_NAME || ""));
      } catch (_) {}
    }
    return this._modelFileById.get(Number(modelId)) || null;
  }

  // On-demand mesh for any model id: parse the .adr/.dme (full detail) and cache.
  // Binary "MSH1": u32 headerLen | header JSON {texture} | u32 vc | u32 ic |
  //                f32 verts[vc*5] (x,y,z,u,v) | u32 indices[ic]
  serveModelMesh(res, modelId) {
    if (!this._meshCache) this._meshCache = new Map();
    let buf = this._meshCache.get(modelId);
    if (buf === undefined) {
      buf = null;
      const adr = this.modelFileById(modelId);
      if (adr) {
        try {
          const dmePath = dme.pickDme(this.config.assetsDir, adr, true);
          const mesh = dmePath ? dme.parseDme(dmePath) : null;
          if (mesh) {
            const texture = dme.pickDiffuse([...mesh.texNames, ...dme.adrTextureAliases(this.config.assetsDir, adr)]) || "";
            let headerJson = JSON.stringify({ texture });
            while (Buffer.byteLength(headerJson) % 4 !== 0) headerJson += " ";
            const header = Buffer.from(headerJson, "utf8");
            const vc = mesh.verts.length / 5, ic = mesh.indices.length;
            buf = Buffer.alloc(4 + 4 + header.length + 8 + vc * 20 + ic * 4);
            let off = 0;
            buf.write("MSH1", off); off += 4;
            buf.writeUInt32LE(header.length, off); off += 4;
            header.copy(buf, off); off += header.length;
            buf.writeUInt32LE(vc, off); buf.writeUInt32LE(ic, off + 4); off += 8;
            for (const v of mesh.verts) { buf.writeFloatLE(v, off); off += 4; }
            for (const i of mesh.indices) { buf.writeUInt32LE(i, off); off += 4; }
          }
        } catch (err) {
          console.warn(`[h1emu-web-editor] Mesh parse failed for model ${modelId}: ${err.message}`);
        }
      }
      this._meshCache.set(modelId, buf);
    }
    if (!buf) { sendJson(res, 404, { message: "No mesh for that model." }); return; }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": buf.length, "Cache-Control": "public, max-age=3600" });
    res.end(buf);
  }

  // Serves any texture from the assets dump, mip-capped to 256px, cached.
  serveModelTexture(res, texName) {
    if (!texName || texName.includes("..") || texName.includes("/") || texName.includes("\\")) {
      sendJson(res, 400, { message: "Invalid texture name." });
      return;
    }
    if (!this._texCache) this._texCache = new Map();
    let buf = this._texCache.get(texName);
    if (buf === undefined) {
      buf = null;
      const src = path.join(this.config.assetsDir, texName);
      try {
        if (fs.existsSync(src)) buf = dme.capDds(fs.readFileSync(src), 256);
      } catch (_) {}
      this._texCache.set(texName, buf);
    }
    if (!buf) { sendJson(res, 404, { message: "Texture not found." }); return; }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": buf.length, "Cache-Control": "public, max-age=3600" });
    res.end(buf);
  }

  // ---------- editor-placed object persistence ----------
  // The zone server's own world save only persists foundations (with attached
  // children) and world lootables. Free-standing walls/shelters, doors with no
  // parent, and arbitrary prop models would vanish on restart — so the plugin
  // keeps its own registry and respawns them.
  registryFile() { return path.join(this.dir || __dirname, "editor-objects.json"); }

  isServerPersisted(entry) {
    if (entry.kind === "foundation" || entry.kind === "lootable" || entry.kind === "worldLootable") return true;
    if (entry.kind === "simple" || entry.kind === "door") return Boolean(entry.entity.parentObjectCharacterId);
    return false;
  }

  loadRegistry() {
    try {
      const data = JSON.parse(fs.readFileSync(this.registryFile(), "utf8"));
      return Array.isArray(data) ? data : [];
    } catch (_) { return []; }
  }

  persistRegistry() {
    try {
      const tmp = `${this.registryFile()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.editorObjects, null, 2));
      fs.renameSync(tmp, this.registryFile());
    } catch (err) {
      console.warn(`[h1emu-web-editor] Could not persist editor objects: ${err.message}`);
    }
  }

  registerEditorObject(entry, itemDefinitionId, modelId) {
    if (this.isServerPersisted(entry)) return;
    const sig = this.entitySig(entry.entity) || [0, 0, 0, 0, 1];
    const record = { rid: crypto.randomBytes(8).toString("hex"), itemDefinitionId, modelId, pos: [sig[0], sig[1], sig[2]], euler: sig[3], scale: sig[4] };
    this.editorObjects.push(record);
    this.registryByCharacterId.set(String(entry.entity.characterId), record);
    this.persistRegistry();
  }

  respawnEditorObjects() {
    if (this.editorObjectsSpawned) return;
    this.editorObjectsSpawned = true;
    let ok = 0;
    for (const record of this.editorObjects) {
      const entry = this.placeConstructionEntity(Number(record.itemDefinitionId) || 0, Number(record.modelId) || 0, vector3(record.pos), toNumber(record.euler), toNumber(record.scale, 1));
      if (entry) {
        this.registryByCharacterId.set(String(entry.entity.characterId), record);
        ok++;
      }
    }
    if (this.editorObjects.length) console.log(`[h1emu-web-editor] Respawned ${ok}/${this.editorObjects.length} editor-placed objects.`);
  }

  constructionDictionaries() {
    const server = this.zoneServer();
    return [
      ["foundation", server?._constructionFoundations],
      ["simple", server?._constructionSimple],
      ["door", server?._constructionDoors],
      ["lootable", server?._lootableConstruction],
      ["worldLootable", server?._worldLootableConstruction],
      ["worldSimple", server?._worldSimpleConstruction],
    ].filter(([, dict]) => dict && typeof dict === "object");
  }

  dictForKind(kind) {
    const server = this.zoneServer();
    return {
      foundation: server?._constructionFoundations,
      simple: server?._constructionSimple,
      door: server?._constructionDoors,
      lootable: server?._lootableConstruction,
      worldLootable: server?._worldLootableConstruction,
      worldSimple: server?._worldSimpleConstruction,
    }[kind] || null;
  }

  snapshotConstructionIds() {
    const seen = new Set();
    for (const [, dict] of this.constructionDictionaries()) for (const id in dict) seen.add(id);
    return seen;
  }

  findNewConstructionEntry(before) {
    for (const [kind, dict] of this.constructionDictionaries()) {
      for (const id in dict) {
        if (before.has(id)) continue;
        const entity = dict[id];
        if (!entity) continue;
        if (!entity.characterId) entity.characterId = id;
        return { kind, entity, id: String(entity.characterId || id) };
      }
    }
    return null;
  }

  // Creates one construction entity in the world (no broadcast/save). Returns
  // its editor entry, or null. Shared by builder placement and preset spawning.
  placeConstructionEntity(itemDefinitionId, modelId, p, yaw, scaleVal = 1) {
    const server = this.zoneServer();
    const cm = server?.constructionManager;
    if (!cm || typeof server.generateGuid !== "function") return null;
    // itemDefinitionId 0 = raw model prop (from Models.json) placed as a simple construction.
    if (!modelId || !p.every((n) => Number.isFinite(n))) return null;

    const position = new Float32Array([p[0], p[1], p[2], 1]);
    // Construction entities keep yaw in rotation[1]; the manager's place* helpers
    // that run fixEulerOrder themselves expect it in rotation[0] (see fixEulerOrder).
    const fixed = new Float32Array([0, yaw, 0, 0]);
    const raw = new Float32Array([yaw, 0, 0, 0]);
    const s = Math.max(0.05, Number(scaleVal) || 1);
    const scale = new Float32Array([s, s, s, 1]);
    const I = enums.Items;

    const before = this.snapshotConstructionIds();
    try {
      switch (itemDefinitionId) {
        case I.FOUNDATION:
        case I.FOUNDATION_EXPANSION:
        case I.SHACK:
        case I.SHACK_BASIC:
        case I.SHACK_SMALL:
        case I.GROUND_TAMPER: {
          const characterId = server.generateGuid();
          const npc = new ConstructionParentEntity(characterId, server.getTransientId(characterId), modelId,
            position, fixed, server, itemDefinitionId, "", "", "", "", yaw);
          server._constructionFoundations[characterId] = npc;
          break;
        }
        case I.METAL_GATE:
        case I.DOOR_BASIC:
        case I.DOOR_WOOD:
        case I.DOOR_METAL: {
          const characterId = server.generateGuid();
          const npc = new ConstructionDoor(characterId, server.getTransientId(characterId), modelId,
            position, raw, server, itemDefinitionId, "", "", "");
          server._constructionDoors[characterId] = npc;
          break;
        }
        case I.STORAGE_BOX:
        case I.REPAIR_BOX:
          cm.placeLootableConstruction(server, itemDefinitionId, modelId, position, fixed, "");
          break;
        case I.FURNACE:
        case I.BARBEQUE:
        case I.CAMPFIRE:
          cm.placeSmeltingEntity(server, itemDefinitionId, modelId, position, fixed, scale, "");
          break;
        case I.BEE_BOX:
        case I.DEW_COLLECTOR:
        case I.ANIMAL_TRAP:
          cm.placeCollectingEntity(server, itemDefinitionId, modelId, position, fixed, "");
          break;
        default:
          cm.placeSimpleConstruction(server, modelId, position, raw, scale, "", itemDefinitionId);
          break;
      }
    } catch (err) {
      console.warn(`[h1emu-web-editor] Place failed for item ${itemDefinitionId}: ${err.message}`);
      return null;
    }

    const entry = this.findNewConstructionEntry(before);
    if (!entry) return null;
    // Ensure the requested scale actually lands on the entity.
    entry.entity.scale = new Float32Array([s, s, s, 1]);
    if (typeof server.pushToGridCell === "function") server.pushToGridCell(entry.entity);
    this.spawnPlacedEntity(entry);
    const sig = this.entitySig(entry.entity);
    if (sig) this.entitySigs.set(String(entry.entity.characterId), { v: sig, gen: this.scanGen });
    return entry;
  }

  placeObject(msg) {
    const p = vector3(msg.pos);
    const itemDefinitionId = Number(msg?.itemDefinitionId) || 0;
    const modelId = Number(msg?.modelId) || 0;
    const entry = this.placeConstructionEntity(itemDefinitionId, modelId, p, toNumber(msg.euler), toNumber(msg.scale, 1));
    if (!entry) return null;
    this.registerEditorObject(entry, itemDefinitionId, modelId);
    const payload = this.objectPayload(entry);
    this.broadcast({ type: "update", objects: [payload] });
    this.scheduleWorldSave();
    console.log(`[h1emu-web-editor] Placed ${payload.name} (${entry.kind}) at ${p.map((n) => n.toFixed(1)).join(", ")}`);
    return payload;
  }

  // ---------- presets (prefabs) ----------
  presetsDir() {
    const dir = path.join(this.dir || __dirname, "presets");
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return dir;
  }

  presetPath(name) {
    const safe = String(name || "").replace(/[^a-zA-Z0-9 _\-()]/g, "").trim().slice(0, 64);
    if (!safe) return null;
    return { safe, file: path.join(this.presetsDir(), `${safe}.json`) };
  }

  listPresets() {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(this.presetsDir()); } catch (_) {}
    for (const f of files) {
      if (!f.toLowerCase().endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.presetsDir(), f), "utf8"));
        if (Array.isArray(data.objects)) out.push(data);
      } catch (_) {}
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  savePreset(msg) {
    const target = this.presetPath(msg?.name);
    if (!target) return null;
    const objects = (Array.isArray(msg.objects) ? msg.objects : [])
      .map((o) => ({
        itemDefinitionId: Number(o.itemDefinitionId) || 0,
        modelId: Number(o.modelId) || 0,
        rel: vector3(o.rel),
        euler: toNumber(o.euler),
        scale: Math.max(0.05, toNumber(o.scale, 1)),
      }))
      .filter((o) => o.modelId); // itemDefinitionId 0 = raw prop model, allowed
    if (!objects.length) return null;
    const preset = { name: target.safe, created: Date.now(), objects };
    try {
      fs.writeFileSync(target.file, JSON.stringify(preset, null, 2));
    } catch (err) {
      console.warn(`[h1emu-web-editor] Could not save preset: ${err.message}`);
      return null;
    }
    console.log(`[h1emu-web-editor] Saved preset "${target.safe}" (${objects.length} objects).`);
    return preset;
  }

  deletePreset(name) {
    const target = this.presetPath(name);
    if (!target || !fs.existsSync(target.file)) return false;
    try { fs.unlinkSync(target.file); return true; } catch (_) { return false; }
  }

  // Spawns a saved preset with anchor `pos` and placement `euler`, rotating each
  // object's stored offset/facing by that yaw. All placed in one batch.
  spawnPreset(msg) {
    const target = this.presetPath(msg?.name);
    if (!target || !fs.existsSync(target.file)) return false;
    let preset;
    try { preset = JSON.parse(fs.readFileSync(target.file, "utf8")); } catch (_) { return false; }
    const anchor = vector3(msg.pos);
    if (!anchor.every((n) => Number.isFinite(n))) return false;
    const yaw = toNumber(msg.euler);
    const cos = Math.cos(yaw), sin = Math.sin(yaw);

    const payloads = [];
    for (const o of preset.objects || []) {
      const rel = vector3(o.rel);
      // Rotate the stored XZ offset around Y (same convention as foundation drag).
      const wx = anchor[0] + cos * rel[0] + sin * rel[2];
      const wz = anchor[2] - sin * rel[0] + cos * rel[2];
      const entry = this.placeConstructionEntity(Number(o.itemDefinitionId) || 0, Number(o.modelId) || 0,
        [wx, anchor[1] + rel[1], wz], toNumber(o.euler) + yaw, toNumber(o.scale, 1));
      if (entry) {
        this.registerEditorObject(entry, Number(o.itemDefinitionId) || 0, Number(o.modelId) || 0);
        payloads.push(this.objectPayload(entry));
      }
    }
    if (!payloads.length) return false;
    this.broadcast({ type: "update", objects: payloads });
    this.scheduleWorldSave();
    console.log(`[h1emu-web-editor] Spawned preset "${target.safe}" (${payloads.length} objects).`);
    return true;
  }

  deleteObject(id) {
    const entry = this.findPlacedObject(id);
    if (!entry || !this.isConstructionEntry(entry)) return false;
    const server = this.zoneServer();
    const dict = this.dictForKind(entry.kind);
    if (!dict) return false;
    // Take the whole base with a foundation, otherwise pieces would be orphaned.
    const targets = [entry];
    if (entry.kind === "foundation") {
      for (const child of this.constructionChildren(entry.entity)) {
        const childEntry = this.findPlacedObject(child.characterId);
        if (childEntry && childEntry.entity !== entry.entity) targets.push(childEntry);
      }
    }
    const removed = [];
    for (const target of targets) {
      const targetDict = this.dictForKind(target.kind);
      if (!targetDict) continue;
      try {
        if (typeof server?.deleteEntity === "function") server.deleteEntity(target.entity.characterId, targetDict);
        else { this.despawnPlacedEntity(target.entity); delete targetDict[target.entity.characterId]; }
      } catch (_) {
        this.despawnPlacedEntity(target.entity);
        delete targetDict[target.entity.characterId];
      }
      removed.push(String(target.entity.characterId));
      this.entitySigs.delete(String(target.entity.characterId));
      const record = this.registryByCharacterId.get(String(target.entity.characterId));
      if (record) {
        this.registryByCharacterId.delete(String(target.entity.characterId));
        this.editorObjects = this.editorObjects.filter((r) => r.rid !== record.rid);
        this.persistRegistry();
      }
    }
    this.removeEntitiesFromGrid(new Set(targets.map((t) => t.entity)), server);
    if (removed.length) this.broadcast({ type: "removed", ids: removed });
    this.scheduleWorldSave();
    console.log(`[h1emu-web-editor] Deleted ${removed.length} construction(s) starting at ${id}`);
    return true;
  }

  scheduleWorldSave() {
    const server = this.zoneServer();
    if (typeof server?.saveWorld !== "function") return;
    if (this.saveWorldTimer) clearTimeout(this.saveWorldTimer);
    this.saveWorldTimer = setTimeout(() => {
      this.saveWorldTimer = null;
      Promise.resolve(server.saveWorld()).then(
        () => console.log("[h1emu-web-editor] World save triggered after edit."),
        (err) => console.warn(`[h1emu-web-editor] World save failed: ${err.message}`)
      );
    }, 5000);
  }

  removeEntitiesFromGrid(entitySet, server) {
    const grid = (server || this.zoneServer())?._grid || [];
    for (const cell of grid) {
      const objs = cell.objects;
      if (!objs || !objs.length) continue;
      let w = 0;
      for (let r = 0; r < objs.length; r++) {
        if (!entitySet.has(objs[r])) objs[w++] = objs[r];
      }
      if (w !== objs.length) objs.length = w;
    }
  }

  constructionChildren(entity, out = []) {
    for (const key of ["occupiedWallSlots", "occupiedUpperWallSlots", "occupiedShelterSlots", "occupiedRampSlots", "occupiedExpansionSlots", "freeplaceEntities"]) {
      for (const child of Object.values(entity?.[key] || {})) {
        if (!child?.characterId || out.includes(child)) continue;
        out.push(child);
        this.constructionChildren(child, out);
      }
    }
    return out;
  }

  isConstructionEntry(entry) {
    return ["foundation", "simple", "door", "lootable", "worldLootable", "worldSimple"].includes(entry.kind);
  }

  persistConstructionTransforms(applied) {
    const transforms = applied.filter(([entry]) => this.isConstructionEntry(entry)).map(([, transform]) => transform);
    if (!transforms.length) return;
    const server = this.zoneServer();
    if (typeof server?.saveWorld === "function") {
      // Let the server persist its own live entities (single writer, guarded
      // against concurrent saves) instead of the plugin writing save files.
      this.scheduleWorldSave();
      return;
    }
    if (this.isMongoBackedServer()) {
      for (const transform of transforms) void this.persistMongoConstructionTransform(transform);
      return;
    }
    const worldDataPath = path.join(getAppDataFolderPath(), "worlddata");
    let updatedAny = false;
    for (const fileName of ["construction.json", "worldconstruction.json"]) {
      const filePath = path.join(worldDataPath, fileName);
      const records = this.readJsonArray(filePath);
      if (!records.length) continue;
      let updated = false;
      for (const transform of transforms) {
        if (this.updateSavedRecordListTransform(records, transform)) updated = true;
      }
      if (updated) {
        const tmpPath = `${filePath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(records));
        fs.renameSync(tmpPath, filePath);
        updatedAny = true;
      }
    }
    if (updatedAny) console.log(`[h1emu-web-editor] Persisted ${transforms.length} construction transform(s) to single-player save files.`);
  }

  updateSavedRecordListTransform(records, transform) {
    let updated = false;
    for (const record of records) {
      if (this.updateSavedRecordTransform(record, transform)) updated = true;
    }
    return updated;
  }

  updateSavedRecordTransform(record, transform) {
    if (!record || typeof record !== "object") return false;
    let updated = false;
    if (String(record.characterId) === String(transform.id)) {
      const w = Array.isArray(record.position) && record.position.length > 3 ? record.position[3] : 1;
      record.position = [transform.pos[0], transform.pos[1], transform.pos[2], w];
      const tail = Array.isArray(record.rotation) && record.rotation.length > 3 ? record.rotation[3] : 0;
      if (record.passwordHash !== undefined) {
        // Door/gate record: yaw goes in rotation[0] (matches startRot on load).
        record.rotation = [transform.euler, 0, 0, tail];
      } else {
        record.eulerAngle = transform.euler;
        record.rotation = [0, transform.euler, 0, tail];
      }
      if (Array.isArray(record.scale)) record.scale = [transform.scale[0], transform.scale[1], transform.scale[2], record.scale[3] ?? 1];
      updated = true;
    }
    for (const key of ["occupiedWallSlots", "occupiedUpperWallSlots", "occupiedShelterSlots", "occupiedRampSlots", "occupiedExpansionSlots", "freeplaceEntities"]) {
      for (const child of Object.values(record[key] || {})) {
        if (this.updateSavedRecordTransform(child, transform)) updated = true;
      }
    }
    return updated;
  }

  async persistMongoConstructionTransform(transform) {
    const db = this.server?._db;
    const serverId = this.server?._worldId;
    if (!db || serverId === undefined) return;
    const update = {
      $set: {
        position: [transform.pos[0], transform.pos[1], transform.pos[2], 1],
        rotation: [0, transform.euler, 0, 0],
        eulerAngle: transform.euler,
      },
    };
    try {
      const [construction, worldConstruction] = await Promise.all([
        db.collection(DB_COLLECTIONS.CONSTRUCTION).updateOne({ serverId, characterId: transform.id }, update),
        db.collection(DB_COLLECTIONS.WORLD_CONSTRUCTIONS).updateOne({ serverId, characterId: transform.id }, update),
      ]);
      if (construction.modifiedCount || worldConstruction.modifiedCount) {
        console.log(`[h1emu-web-editor] Persisted construction transform ${transform.id} to MongoDB.`);
      }
    } catch (err) {
      console.warn(`[h1emu-web-editor] Could not persist construction transform ${transform.id} to MongoDB: ${err.message}`);
    }
  }

  mutateEntityOnly(entry, transform) {
    const entity = entry.entity;
    if (!entity.state) entity.state = {};
    entity.state.position = new Float32Array(transform.pos);
    entity.position = entity.state.position;

    if (entity.startRot) {
      // Door/gate (DoorEntity): yaw lives in startRot[0]; open/closed angles are
      // derived from it and state.rotation is a quaternion. The save format also
      // writes rotation straight from startRot, so keep them all in sync.
      const startRot = Array.from(entity.startRot);
      while (startRot.length < 4) startRot.push(0);
      startRot[0] = transform.euler;
      entity.startRot = new Float32Array(startRot.slice(0, 4));
      entity.closedAngle = transform.euler;
      entity.openAngle = transform.euler + 1.575;
      entity.state.rotation = new Float32Array(eul2quat(new Float32Array(startRot.slice(0, 4))));
      entity.rotation = entity.state.rotation;
    } else {
      const rot = this.entityRotation(entity) ? Array.from(this.entityRotation(entity)) : [0, 0, 0, 0];
      rot[1] = transform.euler;
      entity.state.rotation = new Float32Array(rot.length >= 4 ? rot.slice(0, 4) : [0, transform.euler, 0, 0]);
      entity.rotation = entity.state.rotation;
      if ("eulerAngle" in entity) entity.eulerAngle = transform.euler;
    }
    entity.scale = new Float32Array([transform.scale[0], transform.scale[1], transform.scale[2], 1]);
    this.refreshConstructionGeometry(entry);
  }

  refreshConstructionGeometry(entry) {
    const entity = entry.entity;
    const p = entity.state.position;
    const yaw = this.entityYaw(entity);
    if (entry.kind === "door" && "fixedPosition" in entity) {
      const distance = entity.itemDefinitionId === enums.Items.DOOR_METAL || entity.itemDefinitionId === enums.Items.DOOR_WOOD ? 0.625 : 2.5;
      entity.fixedPosition = movePoint(p, -toNumber(entity.openAngle), distance);
      return;
    }
    if (entry.kind === "simple" || entry.kind === "worldSimple") {
      switch (entity.itemDefinitionId) {
        case enums.Items.SHELTER_LARGE:
        case enums.Items.SHELTER_UPPER_LARGE: {
          const centerPoint = movePoint(p, -yaw + (90 * Math.PI) / 180, 2.5);
          entity.fixedPosition = centerPoint;
          entity.cubebounds = getCubeBounds(centerPoint, 10, 5, -yaw, p[1], p[1] + 1.8);
          entity.boundsOn = getCubeBounds(centerPoint, 10, 5, -yaw, p[1] + 2.4, p[1] + 4.2);
          break;
        }
        case enums.Items.SHELTER:
        case enums.Items.SHELTER_UPPER:
          entity.fixedPosition = undefined;
          entity.cubebounds = getCubeBounds(p, 5, 5, -yaw, p[1], p[1] + 1.8);
          entity.boundsOn = getCubeBounds(p, 5, 5, -yaw, p[1] + 2.4, p[1] + 4.2);
          break;
        case enums.Items.METAL_DOORWAY:
        case enums.Items.METAL_WALL:
          entity.fixedPosition = movePoint(p, -(yaw + 1.575), 2.5);
          break;
        default:
          if ("fixedPosition" in entity && entity.fixedPosition) entity.fixedPosition = new Float32Array(p);
      }
      return;
    }
    if (entry.kind === "foundation") {
      switch (entity.itemDefinitionId) {
        case enums.Items.SHACK:
          entity.cubebounds = getCubeBounds(p, 4.7, 5, -yaw, p[1] + 0.7, p[1] + 2.8);
          break;
        case enums.Items.SHACK_SMALL:
          entity.cubebounds = getCubeBounds(p, 3.5, 2.5, -yaw, p[1] + 0.7, p[1] + 2.8);
          break;
        case enums.Items.SHACK_BASIC:
          entity.cubebounds = getCubeBounds(p, 1.6, 1.6, -yaw, p[1], p[1] + 1.7);
          break;
      }
    }
  }

  despawnPlacedEntity(entity) {
    const server = this.zoneServer();
    for (const target of Object.values(server?._clients || {})) {
      if (target.spawnedEntities?.has?.(entity)) {
        server.sendData(target, "Character.RemovePlayer", {
          characterId: entity.characterId,
          unknownWord1: 0,
          effectId: 0,
          timeToDisappear: 0,
          effectDelay: 0,
        });
        target.spawnedEntities.delete(entity);
      }
    }
  }

  spawnPlacedEntity(entry) {
    const server = this.zoneServer();
    const entity = entry.entity;
    const spawn = (target) => {
      if (entry.kind === "foundation" && server.constructionManager?.spawnConstructionParent) {
        server.constructionManager.spawnConstructionParent(server, target, entity);
      } else if (entry.kind === "door" && server.constructionManager?.spawnConstructionDoor) {
        server.constructionManager.spawnConstructionDoor(server, target, entity);
      } else if ((entry.kind === "simple" || entry.kind === "worldSimple") && server.constructionManager?.spawnSimpleConstruction) {
        server.constructionManager.spawnSimpleConstruction(server, target, entity);
      } else if ((entry.kind === "lootable" || entry.kind === "worldLootable") && server.constructionManager?.spawnLootableConstruction) {
        server.constructionManager.spawnLootableConstruction(server, target, entity);
      } else if (entity.pGetSimpleNpc && server.addSimpleNpc) {
        server.addSimpleNpc(target, entity);
        target.spawnedEntities?.add?.(entity);
      } else if (entity.pGetLightweight && server.addLightweightNpc) {
        server.addLightweightNpc(target, entity);
        target.spawnedEntities?.add?.(entity);
      }
    };

    if (typeof server.executeFuncForAllReadyClientsInRange === "function") {
      server.executeFuncForAllReadyClientsInRange(spawn, entity);
    } else {
      Object.values(server._clients || {}).forEach(spawn);
    }
  }

  worldToServerMap(x, z) {
    const mapX = ((z - SERVER_MAP_LEFT_Z) / (SERVER_MAP_RIGHT_Z - SERVER_MAP_LEFT_Z)) * SERVER_MAP_COORD_SIZE;
    const mapY = ((SERVER_MAP_TOP_X - x) / (SERVER_MAP_TOP_X - SERVER_MAP_BOTTOM_X)) * SERVER_MAP_COORD_SIZE;
    return {
      x: Math.max(0, Math.min(SERVER_MAP_COORD_SIZE, Math.round(mapX))),
      y: Math.max(0, Math.min(SERVER_MAP_COORD_SIZE, Math.round(mapY))),
    };
  }
}

module.exports = H1emuWebEditorPlugin;
