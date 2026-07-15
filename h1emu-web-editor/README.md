# H1Emu Web Editor

Password-protected browser map editor for H1Emu ZoneServer2016.

## Install

Copy these into your server `plugins` folder:

- `h1emu-web-editor/`
- `h1emu-web-editor-config.yaml`

Start or restart the server, then open the configured address in a browser. The default config listens on `127.0.0.1:8380`.

## Generated terrain assets

The local build can contain several gigabytes of generated terrain and texture files under `public/terrain/`. Those files are intentionally not committed to this repo because some are over GitHub's normal file size limit.

If you already generated terrain assets locally, copy them into:

```text
h1emu-web-editor/public/terrain/
```

The plugin will show a helpful API message when a generated file is missing. The included helper scripts generate the expected files:

- `cnk-to-obj.py` creates terrain data.
- `actors-to-models.js` creates world model data and textures.
- `zone-objects-to-bin.js` creates zone object data.
- `shrink-terrain-textures.js` creates smaller texture copies.
