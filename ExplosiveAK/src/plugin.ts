declare const require: any;

// Everything is loaded through the "@h1z1-server" alias — the PluginManager
// rewrites this to the live server install at load time, so we share the EXACT
// same classes and enums as the running server. That keeps instanceof checks
// working, which is what makes the explosion visual effect + full damage
// pipeline (players, zombies, vehicles, bases, chain reactions) trigger.
const {
  BasePlugin
} = require("@h1z1-server/out/servers/ZoneServer2016/managers/pluginmanager.js");
const {
  ExplosiveEntity
} = require("@h1z1-server/out/servers/ZoneServer2016/entities/explosiveentity.js");
const {
  Items
} = require("@h1z1-server/out/servers/ZoneServer2016/models/enums.js");

// (typed as any so the plugin compiles standalone, without h1z1-server installed)
type ZoneServer2016 = any;
type ZoneClient2016 = any;
type VectorLike = Float32Array | number[];

export default class ServerPlugin extends BasePlugin {
  public name = "ExplosiveAK";
  public description = "AK-47 that fires explosive rounds. Use /expak to get one.";
  public author = "zam";
  public version = "1.1.0";

  /** characterIds that currently have explosive rounds armed */
  private enabled = new Set<string>();
  /** last explosion timestamp per characterId (only used if cooldownMs > 0) */
  private lastBoom = new Map<string, number>();
  /**
   * Scheduled terrain explosions keyed by "characterId:sessionProjectileCount"
   * so each bullet has its own boom, precisely canceled by its own hit report.
   */
  private pendingBooms = new Map<string, any>();

  // config values (see data/defaultconfig.yaml)
  private cooldownMs = 0;
  private ammoCount = 120;
  private allWeapons = false;
  private damageBases = true;
  private projectileSpeed = 350;
  private maxRange = 300;
  private groundSnapTolerance = 4;
  private terrainDelayMs = 100;

  public commands = [
    {
      name: "expak",
      description: "Gives an AK-47 with explosive rounds. Use '/expak off' to disarm.",
      permissionLevel: 2, // ADMIN
      execute: (
        server: ZoneServer2016,
        client: ZoneClient2016,
        args: Array<string>
      ) => {
        const charId = client.character.characterId;

        if (args[0]?.toLowerCase() === "off") {
          this.enabled.delete(charId);
          this.cancelPendingBooms(charId);
          server.sendAlert(client, "Explosive rounds disarmed.");
          return;
        }

        const ak = server.generateItem(Items.WEAPON_AK47, 1, true);
        const ammo = server.generateItem(Items.AMMO_762, this.ammoCount, true);
        if (ak) client.character.lootItem(server, ak);
        if (ammo) client.character.lootItem(server, ammo);

        this.enabled.add(charId);
        server.sendAlert(
          client,
          "EXPLOSIVE AK armed! Every bullet explodes on impact. '/expak off' to disarm."
        );
      }
    }
  ];

  /**
   * This method is called by PluginManager, do NOT call this manually.
   */
  public loadConfig(config: any) {
    this.cooldownMs = Number(config.cooldownMs ?? this.cooldownMs);
    this.ammoCount = Number(config.ammoCount ?? this.ammoCount);
    this.allWeapons = config.allWeapons ?? this.allWeapons;
    this.damageBases = config.damageBases ?? this.damageBases;
    this.projectileSpeed = Number(config.projectileSpeed ?? this.projectileSpeed);
    this.maxRange = Number(config.maxRange ?? this.maxRange);
    this.groundSnapTolerance = Number(
      config.groundSnapTolerance ?? this.groundSnapTolerance
    );
    this.terrainDelayMs = Number(config.terrainDelayMs ?? this.terrainDelayMs);
  }

  public async init(server: ZoneServer2016): Promise<void> {
    // Plugins are initialized for BOTH the LoginServer and the ZoneServer.
    // Only the ZoneServer has weapon packet handling — skip the LoginServer.
    if (!server._packetHandlers || !server.commandHandler) return;

    // 1) Terrain / world impacts.
    //    The client only reports impacts on entities, so for ground/building
    //    shots we compute the impact point ourselves from the fire position +
    //    aim direction (same technique as the Grappeler plugin): ray-march
    //    with bullet drop and sample the navmesh for the ground height.
    server.pluginManager.hookMethod(
      this,
      server._packetHandlers,
      "handleWeaponPacket",
      (_srv: ZoneServer2016, client: ZoneClient2016, packet: any) => {
        if (packet?.packetName === "Weapon.WeaponFireHint") {
          this.handleFireHint(server, client, packet.packet);
        }
      },
      { callBefore: true, callAfter: false }
    );

    // 2) Direct hits on players / zombies / vehicles / objects — precise
    //    impact position reported by the client. Supersedes any scheduled
    //    terrain explosion for this shooter. Normal bullet damage still
    //    applies (callBefore: true) — we just add a boom.
    server.pluginManager.hookMethod(
      this,
      server,
      "registerHit",
      (client: ZoneClient2016, packet: any) => {
        const pos = packet?.hitReport?.position;
        if (!pos) return;
        if (client?.character) {
          // Cancel THIS bullet's scheduled terrain boom (matched by projectile id)
          const spc = packet?.hitReport?.sessionProjectileCount;
          const key = `${client.character.characterId}:${spc}`;
          const timer = this.pendingBooms.get(key);
          if (timer) {
            clearTimeout(timer);
            this.pendingBooms.delete(key);
          }
        }
        this.tryExplode(server, client, pos);
      },
      { callBefore: true, callAfter: false }
    );
  }

  private isExplosiveWeaponEquipped(client: ZoneClient2016): boolean {
    if (this.allWeapons) return true;
    const weapon = client.character.getEquippedWeapon();
    return (
      !!weapon &&
      (weapon.itemDefinitionId === Items.WEAPON_AK47 ||
        weapon.itemDefinitionId === Items.WEAPON_AK47_MODIFIED)
    );
  }

  private handleFireHint(
    server: ZoneServer2016,
    client: ZoneClient2016,
    data: any
  ) {
    if (!data?.position || !data?.rotation) return;
    if (!client?.character) return;
    const charId = client.character.characterId;
    if (!this.enabled.has(charId)) return;
    if (!this.isExplosiveWeaponEquipped(client)) return;

    const direction = this.toDirection(data.rotation);
    if (!direction) return;

    const impact = this.findTerrainImpact(server, data.position, direction);
    if (!impact) return;

    // Boom when the bullet actually gets there: delay = flight time to the
    // impact point, with a small floor so a direct entity hit report (which
    // arrives right after the fire packets) can still cancel/override it.
    const dx = impact[0] - data.position[0];
    const dy = impact[1] - data.position[1];
    const dz = impact[2] - data.position[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const flightMs = (dist / this.projectileSpeed) * 1000;
    const delay = Math.max(flightMs, this.terrainDelayMs);

    // One pending boom per bullet, keyed by projectile id — full-auto spray
    // gets one explosion per shot instead of overwriting each other.
    const key = `${charId}:${data.sessionProjectileCount}`;
    const existing = this.pendingBooms.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingBooms.delete(key);
      this.tryExplode(server, client, impact);
    }, delay);
    this.pendingBooms.set(key, timer);
  }

  private cancelPendingBooms(charId: string) {
    const prefix = `${charId}:`;
    for (const [key, timer] of this.pendingBooms) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer);
        this.pendingBooms.delete(key);
      }
    }
  }

  /** Turn a fire-hint rotation into a unit aim direction. */
  private toDirection(rotation: VectorLike): Float32Array | null {
    const x = rotation[0] ?? 0;
    const y = rotation[1] ?? 0;
    const z = rotation[2] ?? 0;
    const mag = Math.sqrt(x * x + y * y + z * z);
    // If it's (close to) a unit vector, it's already an aim direction.
    if (mag > 0.85 && mag < 1.15) {
      return new Float32Array([x / mag, y / mag, z / mag]);
    }
    // Fallback: interpret as euler angles [yaw, pitch, roll] in radians.
    const yaw = x;
    const pitch = y;
    const cosPitch = Math.cos(pitch);
    return new Float32Array([
      cosPitch * Math.sin(yaw),
      Math.sin(pitch),
      cosPitch * Math.cos(yaw)
    ]);
  }

  /** Ray-march the shot (with bullet drop) against the navmesh ground. */
  private findTerrainImpact(
    server: ZoneServer2016,
    origin: VectorLike,
    direction: Float32Array
  ): Float32Array | null {
    const nav = server.navManager;
    if (!nav?.getClosestNavPointVec3) return null;

    // Closest approach of the ray to the ground, used as a fallback for
    // long/shallow shots where the ray skims just above the terrain and
    // never strictly crosses it.
    let best: { x: number; y: number; z: number; gap: number; t: number } | null =
      null;

    for (let t = 2; t <= this.maxRange; t += 1) {
      // Simulate bullet drop: the real projectile arcs below the aim line.
      const flightTime = t / this.projectileSpeed;
      const drop = 4.9 * flightTime * flightTime;
      const px = origin[0] + direction[0] * t;
      const py = origin[1] + direction[1] * t - drop;
      const pz = origin[2] + direction[2] * t;

      let ground: { x: number; y: number; z: number } | undefined;
      try {
        ground = nav.getClosestNavPointVec3(new Float32Array([px, py, pz, 0]));
      } catch {
        return null;
      }
      if (!ground) continue;
      // Nav query found nothing (returns origin-ish point).
      if (ground.x === 0 && ground.y === 0 && ground.z === 0) continue;

      // Skip if the nearest navmesh point is too far sideways (no ground here).
      const dx = ground.x - px;
      const dz = ground.z - pz;
      if (Math.sqrt(dx * dx + dz * dz) > 2.5) continue;

      const gap = py - ground.y;

      // Ray passed below the ground -> true impact point.
      if (gap <= 0) {
        return new Float32Array([ground.x, ground.y + 0.2, ground.z, 1]);
      }

      if (!best || gap < best.gap) {
        best = { x: ground.x, y: ground.y, z: ground.z, gap, t };
      }
    }

    // Fallback: the ray never crossed the ground, but it got close enough
    // somewhere along the path -> boom at that ground point. Require the
    // snap point to be a few meters out so shots aimed at the sky don't
    // explode at your own feet.
    if (best && best.gap <= this.groundSnapTolerance && best.t >= 5) {
      return new Float32Array([best.x, best.y + 0.2, best.z, 1]);
    }

    return null;
  }

  private tryExplode(
    server: ZoneServer2016,
    client: ZoneClient2016,
    pos: VectorLike
  ) {
    if (!client?.character) return;
    const charId = client.character.characterId;
    if (!this.enabled.has(charId)) return;
    if (!this.isExplosiveWeaponEquipped(client)) return;

    // optional anti-lag throttle (0 = boom for every single bullet)
    if (this.cooldownMs > 0) {
      const now = Date.now();
      if (now - (this.lastBoom.get(charId) ?? 0) < this.cooldownMs) return;
      this.lastBoom.set(charId, now);
    }

    // Spawn a throwaway ExplosiveEntity at the impact point and detonate it
    // immediately — this rides the server's full explosion pipeline:
    // visual effect, sound, player/zombie/vehicle/construction damage,
    // and chain reactions (IEDs, gas cans, landmines).
    const characterId = server.generateGuid();
    const transientId = server.getTransientId(characterId);
    const explosive = new ExplosiveEntity(
      characterId,
      transientId,
      0, // no model needed — it detonates the same tick
      new Float32Array([pos[0], pos[1], pos[2], 1]),
      new Float32Array([0, 0, 0, 1]),
      server,
      this.damageBases ? Items.IED : Items.GRENADE_HE,
      charId
    );
    server._explosives[characterId] = explosive;
    explosive.detonate(charId);
  }
}
