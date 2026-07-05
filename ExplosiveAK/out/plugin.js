"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { BasePlugin } = require("E:/AAA H1z1 JS STUFF/Js download/jsdecmain/Main js Downalods 2016and 15/H1EmuServerFiles/h1z1-server-QuickStart-master/node_modules/h1z1-server/out/servers/ZoneServer2016/managers/pluginmanager.js");
const { ExplosiveEntity } = require("E:/AAA H1z1 JS STUFF/Js download/jsdecmain/Main js Downalods 2016and 15/H1EmuServerFiles/h1z1-server-QuickStart-master/node_modules/h1z1-server/out/servers/ZoneServer2016/entities/explosiveentity.js");
const { Items } = require("E:/AAA H1z1 JS STUFF/Js download/jsdecmain/Main js Downalods 2016and 15/H1EmuServerFiles/h1z1-server-QuickStart-master/node_modules/h1z1-server/out/servers/ZoneServer2016/models/enums.js");
class ServerPlugin extends BasePlugin {
    name = "ExplosiveAK";
    description = "AK-47 that fires explosive rounds. Use /expak to get one.";
    author = "zam";
    version = "1.2.0";
    enabled = new Set();
    lastBoom = new Map();
    pendingBooms = new Map();
    cooldownMs = 0;
    ammoCount = 120;
    allWeapons = false;
    damageBases = true;
    projectileSpeed = 350;
    maxRange = 300;
    groundSnapTolerance = 4;
    terrainDelayMs = 100;
    commands = [
        {
            name: "expak",
            description: "Gives an AK-47 with explosive rounds. Use '/expak off' to disarm.",
            permissionLevel: 2,
            execute: (server, client, args) => {
                const charId = client.character.characterId;
                if (args[0]?.toLowerCase() === "off") {
                    this.enabled.delete(charId);
                    this.cancelPendingBooms(charId);
                    server.sendAlert(client, "Explosive rounds disarmed.");
                    return;
                }
                const ak = server.generateItem(Items.WEAPON_AK47, 1, true);
                const ammo = server.generateItem(Items.AMMO_762, this.ammoCount, true);
                if (ak)
                    client.character.lootItem(server, ak);
                if (ammo)
                    client.character.lootItem(server, ammo);
                this.enabled.add(charId);
                server.sendAlert(client, "EXPLOSIVE AK armed! Every bullet explodes on impact. '/expak off' to disarm.");
            }
        }
    ];
    loadConfig(config) {
        this.cooldownMs = Number(config.cooldownMs ?? this.cooldownMs);
        this.ammoCount = Number(config.ammoCount ?? this.ammoCount);
        this.allWeapons = config.allWeapons ?? this.allWeapons;
        this.damageBases = config.damageBases ?? this.damageBases;
        this.projectileSpeed = Number(config.projectileSpeed ?? this.projectileSpeed);
        this.maxRange = Number(config.maxRange ?? this.maxRange);
        this.groundSnapTolerance = Number(config.groundSnapTolerance ?? this.groundSnapTolerance);
        this.terrainDelayMs = Number(config.terrainDelayMs ?? this.terrainDelayMs);
    }
    async init(server) {
        if (!server._packetHandlers || !server.commandHandler)
            return;
        server.pluginManager.hookMethod(this, server._packetHandlers, "handleWeaponPacket", (_srv, client, packet) => {
            if (packet?.packetName === "Weapon.WeaponFireHint") {
                this.handleFireHint(server, client, packet.packet);
            }
        }, { callBefore: true, callAfter: false });
        server.pluginManager.hookMethod(this, server, "registerHit", (client, packet) => {
            const pos = packet?.hitReport?.position;
            if (!pos)
                return;
            if (client?.character) {
                const spc = packet?.hitReport?.sessionProjectileCount;
                const key = `${client.character.characterId}:${spc}`;
                const timer = this.pendingBooms.get(key);
                if (timer) {
                    clearTimeout(timer);
                    this.pendingBooms.delete(key);
                }
            }
            this.tryExplode(server, client, pos);
        }, { callBefore: true, callAfter: false });
    }
    isExplosiveWeaponEquipped(client) {
        if (this.allWeapons)
            return true;
        const weapon = client.character.getEquippedWeapon();
        return (!!weapon &&
            (weapon.itemDefinitionId === Items.WEAPON_AK47 ||
                weapon.itemDefinitionId === Items.WEAPON_AK47_MODIFIED));
    }
    handleFireHint(server, client, data) {
        if (!data?.position || !data?.rotation)
            return;
        if (!client?.character)
            return;
        const charId = client.character.characterId;
        if (!this.enabled.has(charId))
            return;
        if (!this.isExplosiveWeaponEquipped(client))
            return;
        const direction = this.toDirection(data.rotation);
        if (!direction)
            return;
        const impact = this.findTerrainImpact(server, data.position, direction);
        if (!impact)
            return;
        const dx = impact[0] - data.position[0];
        const dy = impact[1] - data.position[1];
        const dz = impact[2] - data.position[2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const flightMs = (dist / this.projectileSpeed) * 1000;
        const delay = Math.max(flightMs, this.terrainDelayMs);
        const key = `${charId}:${data.sessionProjectileCount}`;
        const existing = this.pendingBooms.get(key);
        if (existing)
            clearTimeout(existing);
        const timer = setTimeout(() => {
            this.pendingBooms.delete(key);
            this.tryExplode(server, client, impact);
        }, delay);
        this.pendingBooms.set(key, timer);
    }
    cancelPendingBooms(charId) {
        const prefix = `${charId}:`;
        for (const [key, timer] of this.pendingBooms) {
            if (key.startsWith(prefix)) {
                clearTimeout(timer);
                this.pendingBooms.delete(key);
            }
        }
    }
    toDirection(rotation) {
        const x = rotation[0] ?? 0;
        const y = rotation[1] ?? 0;
        const z = rotation[2] ?? 0;
        const mag = Math.sqrt(x * x + y * y + z * z);
        if (mag > 0.85 && mag < 1.15) {
            return new Float32Array([x / mag, y / mag, z / mag]);
        }
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
        if (!nav?.getClosestNavPointVec3)
            return null;
        let best = null;
        for (let t = 2; t <= this.maxRange; t += 1) {
            const flightTime = t / this.projectileSpeed;
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
            if (!ground)
                continue;
            if (ground.x === 0 && ground.y === 0 && ground.z === 0)
                continue;
            const dx = ground.x - px;
            const dz = ground.z - pz;
            if (Math.sqrt(dx * dx + dz * dz) > 2.5)
                continue;
            const gap = py - ground.y;
            if (gap <= 0) {
                return new Float32Array([ground.x, ground.y + 0.2, ground.z, 1]);
            }
            if (!best || gap < best.gap) {
                best = { x: ground.x, y: ground.y, z: ground.z, gap, t };
            }
        }
        if (best && best.gap <= this.groundSnapTolerance && best.t >= 5) {
            return new Float32Array([best.x, best.y + 0.2, best.z, 1]);
        }
        return null;
    }
    tryExplode(server, client, pos) {
        if (!client?.character)
            return;
        const charId = client.character.characterId;
        if (!this.enabled.has(charId))
            return;
        if (!this.isExplosiveWeaponEquipped(client))
            return;
        if (this.cooldownMs > 0) {
            const now = Date.now();
            if (now - (this.lastBoom.get(charId) ?? 0) < this.cooldownMs)
                return;
            this.lastBoom.set(charId, now);
        }
        const characterId = server.generateGuid();
        const transientId = server.getTransientId(characterId);
        const explosive = new ExplosiveEntity(characterId, transientId, 0, new Float32Array([pos[0], pos[1], pos[2], 1]), new Float32Array([0, 0, 0, 1]), server, this.damageBases ? Items.IED : Items.GRENADE_HE, charId);
        server._explosives[characterId] = explosive;
        explosive.detonate(charId);
    }
}
exports.default = ServerPlugin;
