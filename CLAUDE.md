# Blockbench fork: custom tools for Distant Early Warning

Personal fork of Blockbench 5.1.6 (JannisX11/blockbench). All work goes on branch `custom`. Since 2026-09-11 the fork takes no upstream updates: everything here is custom, core files may be changed freely, and anything upstream adds later gets re-implemented by hand if wanted. `master` just mirrors upstream.

## Commands
- `npm run build-electron`: bundle, about half a second. After every change.
- `npm run dev`: dev app with remote debugging on port 9223.
- `npm run app`: packaged app in `dist-electron/win-unpacked`, plus `Blockbench.lnk` in the repo root. Fails while Blockbench is open (exe locked), so check `tasklist | grep -i blockbench` first and skip or ask.
- `node tests/dew/run_cdp.mjs tests/dew/<test>.mjs --isolated`: one scripted test against the dev app over CDP. `--isolated` uses a separate profile; required whenever the packaged app is open.
- `npm run test:dew`: every test in sequence. Milestones only.
- `node tests/dew/run_cdp.mjs tests/dew/probe_keymap.mjs`: the user's live keymap, sub-keybinds included (run without `--isolated` so it reads his profile).

## Working rules
- Commit each verified change on `custom` without asking; never push (the user pushes from GitHub Desktop).
- Per change: build, run the test for the feature touched (not the whole suite), then `npm run app` so the user can judge look and feel. Speed matters more than exhaustive testing right now.
- Simple heuristics over optimal ones. Every tunable is a named constant: `BRUSH` in `js/dew/tile_brush.js`, `DEW` in `js/dew/dew_scene.js`.
- No em dashes anywhere (code, comments, commits, replies). Use Bash, not PowerShell.
- The user builds all game content (rooms, clusters). Claude builds and tests tools only.

## Distant Early Warning
- Spec: `D:/Work/DistantEarlyWarning/distantearly_game/BLOCKBENCH_HANDOFF.md`, maintained by the game's own conversation. Read it, never edit it; flag problems to the user. The only thing ever written into the game repo is exported `.glb` files in `content/clusters/`. Values marked [proposed] there are not confirmed.
- Decided in this repo: glTF export scale 16 (a 16-unit cube is 1.0 in the .glb, the game imports at 0.6 m per glTF unit); no two-sided planes in the environment (fences and glass are half a tile thick, or props); a placed tile faces the camera side and its texture reads upright from that side.
- Scale: 1 unit = 1 texel; half cell 16, unit tile 32, storey 64, cluster 320 x 320 [proposed].

### Code map
- `js/dew/dew_scene.js`: DEW Scene format, `DEW` constants, game grid, back-face tint on/off, per-project glTF export options, camera framing for new scenes.
- `js/dew/tile_brush.js`: Tile Select, Tile Brush, Texture Brush, Paint Bucket and their shared helpers (`describeTile`, `tileUV`, `blockTiles`, `stampBlocks`, `buildTileIndex`, snapshot raycast for erasing).
- `js/dew/dew_atlas.js`: DEW Atlas button (flat-color test atlas).
- Small core hooks: `js/preview/canvas.js` (`Format.buildGrid`, back-face uniforms), `js/shaders/{texture,marker,solid,layered}.frag.glsl` (back-face tint), `js/texturing/textures.js` (uniforms, atlas button), `js/uv/uv.js` (tools with `atlas_picker` make the UV editor show `Texture.selected`, receive `onAtlasClick`, and draw `atlas_overlay`), `js/interface/toolbars.js`, `js/main.ts`.
- Tile tool keys: click or drag paints, Ctrl erases or removes, Shift adds (select), W cycles the work plane, A / D step it a half cell, C switches full / half tiles. Bare keys still free: J K L N O Y [ ] 5 7 8 9 0.

## Traps
- Keymap labels: a bracketed modifier ("[Ctrl] + [Shift] + Page Up") is optional, so the bare key is taken. Sub-keybinds (selection modes, slider nudges) are separate from action keybinds; check both before proposing keys.
- Project switch order: `ModelProject.select` loads its editor state, which selects the format (`select_format` fires while `Mode.selected` is still false), then restores the mode and the saved tool, then fires `select_project`. Switch tools or rebuild UI in `select_project`, never in `select_format`.
- Constructors copy fixed field lists. `Tool` and `ModelFormat` now keep unknown options (2026-09-11); `Action`, `BarSelect` and the rest still drop them.
- `Tool.onUnselect` runs before the next tool is selected: defer UI refreshes with `setTimeout(..., 0)`.
- `Texture.select` refreshes the UV editor only in paint mode; the atlas tools listen to `select_texture`.
- Render sides "auto" means double-sided, and the glTF exporter copies it into `doubleSided: true`.
- Selection undo follows the Undo Selections setting (default on in this fork since 2026-09-11). `Undo.finishSelection` cancels itself when nothing changed.
- Erasing during a drag raycasts a snapshot of the geometry from stroke start, or it drills through the holes it just made.
- In face selection mode `preview.raycast` can return vertex or edge hits in front of faces; use `hitFace`.
- CDP tests: a world point can project off the canvas; log the screen point when a click seems to do nothing. Image loads are async; wait before reading a new texture.

## Current state (newest first)
- 2026-09-11: Tile Select and Paint Bucket; multi-cell atlas stamps; Texture Brush and DEW Atlas; erase no longer drills through; back-face tint; Tile Brush; DEW Scene format. Earlier fork features (fit view, welding mode, turn edges, chamfer, auto unwrap and more) are in `git log`.
- Open, not designed yet: move / group / flip for selected tiles; slopes (proposed: tile corner heights in 4-unit steps, Turn Edges picks the fold); diagonal walls; material and cluster edge tags; one-click export to the game folder; stable element names (proposed: element id in glTF node extras, since Blockbench names are neither unique nor stable).
