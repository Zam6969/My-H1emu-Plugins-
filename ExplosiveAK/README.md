# ExplosiveAK

AK-47 that fires explosive rounds — every bullet detonates on impact with the
full server explosion pipeline: blast effect, sound, damage to players,
zombies, vehicles and bases, plus chain reactions (IEDs, gas cans, landmines).

## Command

| Command | Permission | What it does |
|---|---|---|
| `/expak` | Admin (2) | Gives you an AK-47 + 7.62 ammo and arms explosive rounds |
| `/expak off` | Admin (2) | Disarms explosive rounds |

Explosive rounds only trigger while an AK-47 (or modified AK-47) is equipped,
so your other guns stay normal. Careful shooting things at your feet — the
blast hurts you too.

## Install

This folder just needs to be in the server's `plugins` directory (next to
Grappeler). Restart the server. It ships prebuilt — no npm install needed.
On first load a config file `explosiveak-config.yaml` is generated in the
plugins directory.

## Config (explosiveak-config.yaml)

- `cooldownMs` — minimum ms between explosions per player (default 200; 0 = every bullet)
- `ammoCount` — 7.62 ammo given by /expak (default 120)
- `allWeapons` — true = every gun fires explosive rounds, not just the AK (default false)
- `damageBases` — true = IED-strength rounds that damage player bases, false = grenade-strength (default true)

## Rebuilding after editing src/plugin.ts

```
npm install    # or: npm run build (needs typescript)
```
