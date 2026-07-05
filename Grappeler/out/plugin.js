"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pluginmanager_js_1 = require("h1z1-server/out/servers/ZoneServer2016/managers/pluginmanager.js");
const types_1 = require("h1z1-server/out/servers/ZoneServer2016/handlers/commands/types");
const enums_1 = require("h1z1-server/out/servers/ZoneServer2016/models/enums");
const utils_1 = require("h1z1-server/out/utils/utils");
const defaultConfig = {
    enabled: true,
    debug: true,
    adminOnly: true,
    unlimitedAmmo: true,
    damagePlayers: false,
    weaponItemDefinitionId: enums_1.Items.WEAPON_1911,
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
class Grappeler extends pluginmanager_js_1.BasePlugin {
    name = "Grappeler";
    description = "Turns the M1911 into a teleport-to-impact Grappeler weapon.";
    version = "1.2.0";
    config = { ...defaultConfig };
    lastTeleportByCharacterId = new Map();
    pendingTerrainTeleports = new Map();
    commands = [
        {
            name: "grappeler",
            description: "Give yourself the Grappeler M1911 and .45 ammo.",
            permissionLevel: types_1.PermissionLevels.ADMIN,
            execute: (server, client) => {
                const weapon = server.generateItem(this.config.weaponItemDefinitionId, 1, true);
                if (!weapon) {
                    server.sendChatText(client, `[Grappeler] Invalid weapon itemDefinitionId: ${this.config.weaponItemDefinitionId}`);
                    return;
                }
                client.character.lootItem(server, weapon);
                if (this.config.giveAmmoCount > 0) {
                    client.character.lootItem(server, server.generateItem(enums_1.Items.AMMO_45, this.config.giveAmmoCount));
                }
                server.sendChatText(client, "[Grappeler] Added Grappeler to inventory.");
            }
        }
    ];
    loadConfig(config) {
        this.config = {
            ...defaultConfig,
            ...config,
            weaponItemDefinitionId: Number(config.weaponItemDefinitionId ?? defaultConfig.weaponItemDefinitionId),
            giveAmmoCount: Number(config.giveAmmoCount ?? defaultConfig.giveAmmoCount),
            cooldownMs: Number(config.cooldownMs ?? defaultConfig.cooldownMs),
            triggerLoadingScreenDistance: Number(config.triggerLoadingScreenDistance ??
                defaultConfig.triggerLoadingScreenDistance),
            maxGrappleRange: Number(config.maxGrappleRange ?? defaultConfig.maxGrappleRange),
            projectileSpeed: Number(config.projectileSpeed ?? defaultConfig.projectileSpeed),
            groundSnapTolerance: Number(config.groundSnapTolerance ?? defaultConfig.groundSnapTolerance),
            terrainTeleportDelayMs: Number(config.terrainTeleportDelayMs ?? defaultConfig.terrainTeleportDelayMs)
        };
    }
    async init(server) {
        // Plugins are initialized by both the LoginServer and the ZoneServer.
        // Only hook zone methods when running on the ZoneServer.
        if (!("commandHandler" in server)) {
            return;
        }
        // Entity hits (players, zombies, animals, vehicles...).
        // callBefore: false + returning false lets us block the original handler,
        // which is how we prevent damage to players.
        server.pluginManager.hookMethod(this, server, "registerHit", (client, packet) => {
            if (this.config.debug) {
                console.log(`[Grappeler][debug] registerHit pos=${packet?.hitReport?.position}`);
            }
            // An entity hit report supersedes any pending terrain teleport.
            this.cancelPendingTerrainTeleport(client);
            const hitReport = packet?.hitReport;
            if (!hitReport)
                return;
            const firedWeapon = this.getFiredWeapon(client, hitReport.sessionProjectileCount);
            if (firedWeapon?.itemDefinitionId !== this.config.weaponItemDefinitionId) {
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
            if (!this.config.damagePlayers &&
                server.getClientByCharId(hitReport.characterId)) {
                if (this.config.debug) {
                    console.log("[Grappeler][debug] blocked player damage from grappeler hit");
                }
                return false;
            }
        }, { callBefore: false, callAfter: true });
        // The client only reports impacts on entities (via ProjectileHitReport).
        // For terrain/world impacts, nothing is sent, so we compute the impact
        // point ourselves from the fire position + aim direction.
        server.pluginManager.hookMethod(this, server._packetHandlers, "handleWeaponPacket", (_server, client, packet) => {
            if (packet?.packetName === "Weapon.WeaponFireHint") {
                this.handleFireHint(server, client, packet.packet);
            }
        }, { callBefore: true, callAfter: false });
        // Unlimited ammo: refill the mag server-side before every shot...
        server.pluginManager.hookMethod(this, server, "handleWeaponFire", (client, weaponItem) => {
            if (!this.config.unlimitedAmmo || !weaponItem?.weapon)
                return;
            if (weaponItem.itemDefinitionId !== this.config.weaponItemDefinitionId) {
                return;
            }
            if (!this.isAllowed(client))
                return;
            const maxAmmo = server.getWeaponMaxAmmo(weaponItem.itemDefinitionId);
            if (weaponItem.weapon.ammoCount < maxAmmo) {
                weaponItem.weapon.ammoCount = maxAmmo;
            }
        }, { callBefore: false, callAfter: true });
        // ...and make reloads instant + free (no inventory ammo consumed).
        server.pluginManager.hookMethod(this, server, "handleWeaponReload", (client, weaponItem) => {
            if (!this.config.unlimitedAmmo || !weaponItem?.weapon)
                return;
            if (weaponItem.itemDefinitionId !== this.config.weaponItemDefinitionId) {
                return;
            }
            if (!this.isAllowed(client))
                return;
            const maxAmmo = server.getWeaponMaxAmmo(weaponItem.itemDefinitionId);
            weaponItem.weapon.ammoCount = maxAmmo;
            server.sendWeaponReload(client, weaponItem);
            return false; // skip the original reload -> no ammo consumed
        }, { callBefore: false, callAfter: true });
        console.log(`[Grappeler] Loaded. Weapon itemDefinitionId ${this.config.weaponItemDefinitionId} teleports shooters to bullet impact positions.`);
    }
    isAllowed(client) {
        return !this.config.adminOnly || !!client?.isAdmin;
    }
    getFiredWeapon(client, sessionProjectileCount) {
        const fireHint = typeof sessionProjectileCount === "number"
            ? client.fireHints[sessionProjectileCount]
            : undefined;
        return fireHint?.weaponItem ?? client.character.getEquippedWeapon();
    }
    handleFireHint(server, client, data) {
        if (!this.config.enabled || !data?.position || !data?.rotation) {
            return;
        }
        if (!this.isAllowed(client)) {
            return;
        }
        const equippedWeapon = client.character.getEquippedWeapon();
        if (equippedWeapon?.itemDefinitionId !== this.config.weaponItemDefinitionId) {
            return;
        }
        const direction = this.toDirection(data.rotation);
        if (this.config.debug) {
            console.log(`[Grappeler][debug] fireHint rot=[${data.rotation}] dir=[${direction ?? "null"}]`);
        }
        if (!direction) {
            return;
        }
        const impact = this.findTerrainImpact(server, data.position, direction);
        if (this.config.debug) {
            console.log(`[Grappeler][debug] terrain impact=[${impact ?? "none"}]`);
        }
        if (!impact) {
            return;
        }
        // Delay the terrain teleport so an entity hit report (which arrives
        // shortly after the fire packets) can cancel/override it.
        this.cancelPendingTerrainTeleport(client);
        const characterId = client.character.characterId;
        this.pendingTerrainTeleports.set(characterId, setTimeout(() => {
            this.pendingTerrainTeleports.delete(characterId);
            this.teleportClient(server, client, impact, direction);
        }, this.config.terrainTeleportDelayMs));
    }
    cancelPendingTerrainTeleport(client) {
        const characterId = client?.character?.characterId;
        if (!characterId)
            return;
        const pending = this.pendingTerrainTeleports.get(characterId);
        if (pending) {
            clearTimeout(pending);
            this.pendingTerrainTeleports.delete(characterId);
        }
    }
    toDirection(rotation) {
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
    findTerrainImpact(server, origin, direction) {
        const nav = server.navManager;
        if (!nav?.getClosestNavPointVec3) {
            return null;
        }
        // Closest approach of the ray to the ground, used as a fallback for
        // long/shallow shots where the ray skims just above the terrain and
        // never strictly crosses it.
        let best = null;
        let skipped = 0;
        for (let t = 2; t <= this.config.maxGrappleRange; t += 1) {
            // Simulate bullet drop: the real projectile arcs below the aim line.
            const flightTime = t / this.config.projectileSpeed;
            const drop = 4.9 * flightTime * flightTime;
            const px = origin[0] + direction[0] * t;
            const py = origin[1] + direction[1] * t - drop;
            const pz = origin[2] + direction[2] * t;
            let ground;
            try {
                ground = nav.getClosestNavPointVec3(new Float32Array([px, py, pz, 0]));
            }
            catch {
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
                console.log(`[Grappeler][debug] ground snap (gap=${best.gap.toFixed(2)}m)`);
            }
            return new Float32Array([best.x, best.y + 0.2, best.z, 1]);
        }
        if (this.config.debug) {
            console.log(`[Grappeler][debug] no impact: closestGap=${best ? best.gap.toFixed(2) : "n/a"}m skippedSamples=${skipped}/${this.config.maxGrappleRange}`);
        }
        return null;
    }
    teleportClient(server, client, impactPosition, facingDirection) {
        const now = Date.now();
        const characterId = client.character.characterId;
        const lastTeleport = this.lastTeleportByCharacterId.get(characterId) ?? 0;
        if (now - lastTeleport < this.config.cooldownMs) {
            return;
        }
        this.lastTeleportByCharacterId.set(characterId, now);
        const position = this.toFloat32Position(impactPosition);
        const triggerLoadingScreen = this.distance(client.character.state.position, position) >
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
        let rotation;
        if (facingDirection) {
            const yaw = Math.atan2(facingDirection[0], facingDirection[2]);
            rotation = (0, utils_1.eul2quat)(new Float32Array([yaw, 0, 0, 0]));
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
    toFloat32Position(position) {
        return new Float32Array([position[0], position[1], position[2], 1]);
    }
    distance(a, b) {
        const x = a[0] - b[0];
        const y = a[1] - b[1];
        const z = a[2] - b[2];
        return Math.sqrt(x * x + y * y + z * z);
    }
}
exports.default = Grappeler;
