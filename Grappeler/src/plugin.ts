import { BasePlugin } from "h1z1-server/out/servers/ZoneServer2016/managers/pluginmanager.js";
import { ZoneServer2016 } from "h1z1-server/out/servers/ZoneServer2016/zoneserver.js";
import { ZoneClient2016 as Client } from "h1z1-server/out/servers/ZoneServer2016/classes/zoneclient";
import { LoadoutItem } from "h1z1-server/out/servers/ZoneServer2016/classes/loadoutItem";
import {
  Command,
  PermissionLevels
} from "h1z1-server/out/servers/ZoneServer2016/handlers/commands/types";
import { Items } from "h1z1-server/out/servers/ZoneServer2016/models/enums";
import { eul2quat } from "h1z1-server/out/utils/utils";

type VectorLike = Float32Array | number[];

type GrappelerConfig = {
  enabled: boolean;
  debug: boolean;
  adminOnly: boolean;
  unlimitedAmmo: boolean;
  damagePlayers: boolean;
  weaponItemDefinitionId: number;
  giveAmmoCount: number;
  cooldownMs: number;
  triggerLoadingScreenDistance: number;
  maxGrappleRange: number;
  projectileSpeed: number;
  groundSnapTolerance: number;
  terrainTeleportDelayMs: number;
  sendChatText: boolean;
  chatTextMessage: string;
};

const defaultConfig: GrappelerConfig = {
  enabled: true,
  debug: true,
  adminOnly: true,
  unlimitedAmmo: true,
  damagePlayers: false,
  weaponItemDefinitionId: Items.WEAPON_1911,
  giveAmmoCount: 60,
  cooldownMs: 250,
  triggerLoadingScreenDistance: 250,
  maxGrappleRange: 400,
  projectileSpeed: 300,
  groundSnapTolerance: 4,
  terrainTeleportDelayMs: 300,
  sendChatText: true,
  chatTextMessage: "Grappeler!"
};

export default class Grappeler extends BasePlugin {
  public name = "Grappeler";
  public description =
    "Turns the M1911 into a teleport-to-impact Grappeler weapon.";
  public version = "1.2.0";

  private config: GrappelerConfig = { ...defaultConfig };
  private lastTeleportByCharacterId = new Map<string, number>();
  private pendingTerrainTeleports = new Map<string, NodeJS.Timeout>();

  public commands: Command[] = [
    {
      name: "grappeler",
      description: "Give yourself the Grappeler M1911 and .45 ammo.",
      permissionLevel: PermissionLevels.ADMIN,
      execute: (server: ZoneServer2016, client: Client) => {
        const weapon = server.generateItem(
          this.config.weaponItemDefinitionId,
          1,
          true
        );

        if (!weapon) {
          server.sendChatText(
            client,
            `[Grappeler] Invalid weapon itemDefinitionId: ${this.config.weaponItemDefinitionId}`
          );
          return;
        }

        client.character.lootItem(server, weapon);

        if (this.config.giveAmmoCount > 0) {
          client.character.lootItem(
            server,
            server.generateItem(Items.AMMO_45, this.config.giveAmmoCount)
          );
        }

        server.sendChatText(client, "[Grappeler] Added Grappeler to inventory.");
      }
    }
  ];

  public loadConfig(config: Partial<GrappelerConfig>) {
    this.config = {
      ...defaultConfig,
      ...config,
      weaponItemDefinitionId: Number(
        config.weaponItemDefinitionId ?? defaultConfig.weaponItemDefinitionId
      ),
      giveAmmoCount: Number(config.giveAmmoCount ?? defaultConfig.giveAmmoCount),
      cooldownMs: Number(config.cooldownMs ?? defaultConfig.cooldownMs),
      triggerLoadingScreenDistance: Number(
        config.triggerLoadingScreenDistance ??
          defaultConfig.triggerLoadingScreenDistance
      ),
      maxGrappleRange: Number(
        config.maxGrappleRange ?? defaultConfig.maxGrappleRange
      ),
      projectileSpeed: Number(
        config.projectileSpeed ?? defaultConfig.projectileSpeed
      ),
      groundSnapTolerance: Number(
        config.groundSnapTolerance ?? defaultConfig.groundSnapTolerance
      ),
      terrainTeleportDelayMs: Number(
        config.terrainTeleportDelayMs ?? defaultConfig.terrainTeleportDelayMs
      )
    };
  }

  public async init(server: ZoneServer2016): Promise<void> {
    // Plugins are initialized by both the LoginServer and the ZoneServer.
    // Only hook zone methods when running on the ZoneServer.
    if (!("commandHandler" in server)) {
      return;
    }

    // Entity hits (players, zombies, animals, vehicles...).
    // callBefore: false + returning false lets us block the original handler,
    // which is how we prevent damage to players.
    server.pluginManager.hookMethod(
      this,
      server,
      "registerHit",
      (client: Client, packet: any): boolean | void => {
        if (this.config.debug) {
          console.log(
            `[Grappeler][debug] registerHit pos=${packet?.hitReport?.position}`
          );
        }
        // An entity hit report supersedes any pending terrain teleport.
        this.cancelPendingTerrainTeleport(client);

        const hitReport = packet?.hitReport;
        if (!hitReport) return;

        const firedWeapon = this.getFiredWeapon(
          client,
          hitReport.sessionProjectileCount
        );
        if (
          firedWeapon?.itemDefinitionId !== this.config.weaponItemDefinitionId
        ) {
          return; // not the grappeler -> vanilla behavior
        }
        if (!this.isAllowed(client)) {
          return; // non-admin -> behaves like a normal weapon
        }

        if (this.config.enabled && hitReport.position) {
          const from = client.character.state.position;
          const facing = new Float32Array([
            hitReport.position[0] - from[0],
            0,
            hitReport.position[2] - from[2]
          ]);
          this.teleportClient(server, client, hitReport.position, facing);
        }

        // Block the original hit handler when a player was hit -> no damage.
        if (
          !this.config.damagePlayers &&
          server.getClientByCharId(hitReport.characterId)
        ) {
          if (this.config.debug) {
            console.log(
              "[Grappeler][debug] blocked player damage from grappeler hit"
            );
          }
          return false;
        }
      },
      { callBefore: false, callAfter: true }
    );

    // The client only reports impacts on entities (via ProjectileHitReport).
    // For terrain/world impacts, nothing is sent, so we compute the impact
    // point ourselves from the fire position + aim direction.
    server.pluginManager.hookMethod(
      this,
      server._packetHandlers,
      "handleWeaponPacket",
      (_server: ZoneServer2016, client: Client, packet: any) => {
        if (packet?.packetName === "Weapon.WeaponFireHint") {
          this.handleFireHint(server, client, packet.packet);
        }
      },
      { callBefore: true, callAfter: false }
    );

    // Unlimited ammo: refill the mag server-side before every shot...
    server.pluginManager.hookMethod(
      this,
      server,
      "handleWeaponFire",
      (client: Client, weaponItem: LoadoutItem) => {
        if (!this.config.unlimitedAmmo || !weaponItem?.weapon) return;
        if (
          weaponItem.itemDefinitionId !== this.config.weaponItemDefinitionId
        ) {
          return;
        }
        if (!this.isAllowed(client)) return;
        const maxAmmo = server.getWeaponMaxAmmo(weaponItem.itemDefinitionId);
        if (weaponItem.weapon.ammoCount < maxAmmo) {
          weaponItem.weapon.ammoCount = maxAmmo;
        }
      },
      { callBefore: false, callAfter: true }
    );

    // ...and make reloads instant + free (no inventory ammo consumed).
    server.pluginManager.hookMethod(
      this,
      server,
      "handleWeaponReload",
      (client: Client, weaponItem: LoadoutItem): boolean | void => {
        if (!this.config.unlimitedAmmo || !weaponItem?.weapon) return;
        if (
          weaponItem.itemDefinitionId !== this.config.weaponItemDefinitionId
        ) {
          return;
        }
        if (!this.isAllowed(client)) return;
        const maxAmmo = server.getWeaponMaxAmmo(weaponItem.itemDefinitionId);
        weaponItem.weapon.ammoCount = maxAmmo;
        server.sendWeaponReload(client, weaponItem);
        return false; // skip the original reload -> no ammo consumed
      },
      { callBefore: false, callAfter: true }
    );

    console.log(
      `[Grappeler] Loaded. Weapon itemDefinitionId ${this.config.weaponItemDefinitionId} teleports shooters to bullet impact positions.`
    );
  }

  private isAllowed(client: Client): boolean {
    return !this.config.adminOnly || !!client?.isAdmin;
  }

  private getFiredWeapon(
    client: Client,
    sessionProjectileCount: number | undefined
  ): LoadoutItem | undefined {
    const fireHint =
      typeof sessionProjectileCount === "number"
        ? client.fireHints[sessionProjectileCount]
        : undefined;
    return fireHint?.weaponItem ?? client.character.getEquippedWeapon();
  }

  private handleFireHint(server: ZoneServer2016, client: Client, data: any) {
    if (!this.config.enabled || !data?.position || !data?.rotation) {
      return;
    }
    if (!this.isAllowed(client)) {
      return;
    }

    const equippedWeapon = client.character.getEquippedWeapon();
    if (
      equippedWeapon?.itemDefinitionId !== this.config.weaponItemDefinitionId
    ) {
      return;
    }

    const direction = this.toDirection(data.rotation);
    if (this.config.debug) {
      console.log(
        `[Grappeler][debug] fireHint rot=[${data.rotation}] dir=[${direction ?? "null"}]`
      );
    }
    if (!direction) {
      return;
    }

    const impact = this.findTerrainImpact(server, data.position, direction);
    if (this.config.debug) {
      console.log(
        `[Grappeler][debug] terrain impact=[${impact ?? "none"}]`
      );
    }
    if (!impact) {
      return;
    }

    // Delay the terrain teleport so an entity hit report (which arrives
    // shortly after the fire packets) can cancel/override it.
    this.cancelPendingTerrainTeleport(client);
    const characterId = client.character.characterId;
    this.pendingTerrainTeleports.set(
      characterId,
      setTimeout(() => {
        this.pendingTerrainTeleports.delete(characterId);
        this.teleportClient(server, client, impact, direction);
      }, this.config.terrainTeleportDelayMs)
    );
  }

  private cancelPendingTerrainTeleport(client: Client) {
    const characterId = client?.character?.characterId;
    if (!characterId) return;
    const pending = this.pendingTerrainTeleports.get(characterId);
    if (pending) {
      clearTimeout(pending);
      this.pendingTerrainTeleports.delete(characterId);
    }
  }

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

  private findTerrainImpact(
    server: ZoneServer2016,
    origin: VectorLike,
    direction: Float32Array
  ): Float32Array | null {
    const nav = (server as any).navManager;
    if (!nav?.getClosestNavPointVec3) {
      return null;
    }

    // Closest approach of the ray to the ground, used as a fallback for
    // long/shallow shots where the ray skims just above the terrain and
    // never strictly crosses it.
    let best: {
      x: number;
      y: number;
      z: number;
      gap: number;
      t: number;
    } | null = null;
    let skipped = 0;

    for (let t = 2; t <= this.config.maxGrappleRange; t += 1) {
      // Simulate bullet drop: the real projectile arcs below the aim line.
      const flightTime = t / this.config.projectileSpeed;
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
      if (!ground) {
        skipped++;
        continue;
      }
      // Nav query found nothing (returns origin-ish point).
      if (ground.x === 0 && ground.y === 0 && ground.z === 0) {
        skipped++;
        continue;
      }

      // Skip if the nearest navmesh point is too far sideways (no ground here).
      const dx = ground.x - px;
      const dz = ground.z - pz;
      if (Math.sqrt(dx * dx + dz * dz) > 2.5) {
        skipped++;
        continue;
      }

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
    // somewhere along the path -> snap to that ground point. Require the
    // snap point to be a few meters out so shots aimed at the sky don't
    // teleport you to your own feet.
    if (best && best.gap <= this.config.groundSnapTolerance && best.t >= 5) {
      if (this.config.debug) {
        console.log(
          `[Grappeler][debug] ground snap (gap=${best.gap.toFixed(2)}m)`
        );
      }
      return new Float32Array([best.x, best.y + 0.2, best.z, 1]);
    }

    if (this.config.debug) {
      console.log(
        `[Grappeler][debug] no impact: closestGap=${best ? best.gap.toFixed(2) : "n/a"}m skippedSamples=${skipped}/${this.config.maxGrappleRange}`
      );
    }
    return null;
  }

  private teleportClient(
    server: ZoneServer2016,
    client: Client,
    impactPosition: VectorLike,
    facingDirection?: Float32Array | null
  ) {
    const now = Date.now();
    const characterId = client.character.characterId;
    const lastTeleport = this.lastTeleportByCharacterId.get(characterId) ?? 0;
    if (now - lastTeleport < this.config.cooldownMs) {
      return;
    }
    this.lastTeleportByCharacterId.set(characterId, now);

    const position = this.toFloat32Position(impactPosition);
    const triggerLoadingScreen =
      this.distance(client.character.state.position, position) >
      this.config.triggerLoadingScreenDistance;

    client.managedObjects?.forEach((managedCharacterId) => {
      server.dropVehicleManager(client, managedCharacterId);
    });
    server.dropAllManagedObjects(client);

    client.character.state.position = position;
    if (client.character.positionUpdate) {
      client.character.positionUpdate.position = Array.from(position);
    }

    // Preserve the direction the player was aiming when they fired.
    let rotation: Float32Array | undefined;
    if (facingDirection) {
      const yaw = Math.atan2(facingDirection[0], facingDirection[2]);
      rotation = eul2quat(new Float32Array([yaw, 0, 0, 0]));
      client.character.state.yaw = yaw;
    }

    server.sendData(client, "ClientUpdate.UpdateLocation", {
      position,
      ...(rotation ? { rotation } : {}),
      triggerLoadingScreen
    });

    if (this.config.sendChatText && this.config.chatTextMessage) {
      server.sendChatText(client, this.config.chatTextMessage);
    }
  }

  private toFloat32Position(position: VectorLike): Float32Array {
    return new Float32Array([position[0], position[1], position[2], 1]);
  }

  private distance(a: VectorLike, b: VectorLike): number {
    const x = a[0] - b[0];
    const y = a[1] - b[1];
    const z = a[2] - b[2];
    return Math.sqrt(x * x + y * y + z * z);
  }
}
