# My H1Emu Plugins

Plugins included:

- ExplosiveAK
- Grappeler
- h1emu-web-editor

## How to install

1. Download this repo or clone it.
2. Open your H1Emu server folder.
3. Put the plugin folders and config files into your server's `plugins` folder.

The files you want in the `plugins` folder are:

- `ExplosiveAK/`
- `Grappeler/`
- `h1emu-web-editor/`
- `explosiveak-config.yaml`
- `grappeler-config.yaml`
- `h1emu-web-editor-config.yaml`

After that, start or restart your server.

## Commands

These are admin commands:

- `/expak` - gives you an AK-47 with explosive rounds and 7.62 ammo.
- `/expak off` - turns off explosive rounds.
- `/grappeler` - gives you the Grappeler M1911 and .45 ammo.

For the Grappeler, shoot where you want to grapple/teleport.

## Web Editor

The web editor runs a local browser editor for ZoneServer2016. By default, it listens on `127.0.0.1:8380` with the password from `h1emu-web-editor-config.yaml`.

Large generated terrain assets are not committed to this repo. If you have already generated them locally, place them in `h1emu-web-editor/public/terrain/` after installing the plugin.
