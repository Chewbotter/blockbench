// The Block Painting tab: beside Edit in any format with meshes, holding the tile tools and the Material Brush. Their
// hotkeys fire only there, the viewport rules the DEW Scene format used to carry (culling, game grid, fabric snap and
// size limits) follow the tab in and out, each tab keeps its own tool, and painting works in a generic project.
import assert from 'assert';
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type == 'page' && t.url.includes('index.html')) ?? targets.find(t => t.type == 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method == 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result.result.value; };
const json = async (expr) => JSON.parse(await ev(expr));
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { if (await ev('typeof Blockbench != "undefined" && !!window.Preview && Preview.all.length > 0')) break; await sleep(500); }
await send('Runtime.enable');
let passed = 0;
const check = (name, ok, detail) => { assert.ok(ok, name + (detail !== undefined ? ': ' + JSON.stringify(detail) : '')); console.log('PASS', name); passed++; };

const screen = async (x, y, z) => JSON.parse(await ev(`(() => { let p = Preview.selected; let v = new THREE.Vector3(${x}, ${y}, ${z}).project(p.camera); let r = p.canvas.getBoundingClientRect(); return JSON.stringify([r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height, r.left, r.top, r.right, r.bottom]); })()`));
const mouse = (type, [x, y], extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
async function click(world) {
	const [x, y, left, top, right, bottom] = await screen(...world);
	assert.ok(x > left && x < right && y > top && y < bottom, 'the click point is on the canvas: ' + JSON.stringify([x, y, left, top, right, bottom]));
	for (let i = 0; i < 2; i++) { await mouse('mouseMoved', [x, y], { button: 'none' }); await sleep(60); }
	await mouse('mousePressed', [x, y], { buttons: 1 }); await sleep(50);
	await mouse('mouseReleased', [x, y]); await sleep(120);
}
async function press(key) {
	const vk = key.toUpperCase().charCodeAt(0);
	const code = /[0-9]/.test(key) ? 'Digit' + key : 'Key' + key.toUpperCase();
	await ev(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
	await sleep(120);
}
const BLOCK_TOOLS = ['dew_tile_select', 'dew_whole_block', 'dew_tile_brush', 'dew_shave', 'dew_ramp', 'dew_terrain', 'dew_material_brush', 'dew_texture_brush', 'dew_paint_bucket'];
const EDIT_ONLY = ['dew_cage', 'dew_edge_boundary', 'turn_edges_tool', 'knife_tool', 'seam_tool', 'vertex_snap_tool', 'pivot_tool'];
const state = `JSON.stringify({mode: Modes.id, edit: !!Modes.edit, block: !!Modes.block, tool: Toolbox.selected.id, format: Format.id})`;
const shown = `JSON.stringify(Toolbars.tools.children.filter(item => item instanceof Tool && Condition(item.condition)).map(item => item.id))`;
const view = `JSON.stringify({front: Canvas.getRenderSide() == THREE.FrontSide, step: canvasGridSize(), user_step: 16 / settings.edit_size.value,
	dew_grid: three_grid.children.length > 0 && three_grid.children.every(c => c.name == 'grid'), limiter: !!Format.cube_size_limiter, tint: Canvas.backfaceUniforms.BACKFACE_TINT.value})`;

// A. a generic project, Edit tab: the tab is offered, its tools are not, and their keys do nothing
await ev(`(() => { newProject(Formats.free); let m = new Mesh({name: 'quad', vertices: {}}); let k = m.addVertices([0,0,0],[16,0,0],[16,0,16],[0,0,16]); m.addFaces(new MeshFace(m, {vertices: k})); m.init(); m.select(); })()`);
let tabs = await json(`JSON.stringify({exists: !!Modes.options.block, name: Modes.options.block?.name, offered: Condition(Modes.options.block.condition), order: Object.keys(Modes.options),
	in_tab_bar: [...document.querySelectorAll('#mode_selector li')].map(n => n.textContent.trim())})`);
check('A. the Block Painting tab is offered in a generic project', tabs.exists && tabs.offered && tabs.name == 'Block Painting' && tabs.in_tab_bar.some(label => label.endsWith('Block Painting')), tabs);
let edit_shown = await json(shown);
check('   none of its tools show in the Edit tab', BLOCK_TOOLS.every(id => !edit_shown.includes(id)), edit_shown);
await press('2');
let after_2 = await json(`JSON.stringify({tool: Toolbox.selected.id, selection_mode: BarItems.selection_mode.value})`);
check('   pressing 2 in Edit picks no tile tool (it is the selection mode key there)', !BLOCK_TOOLS.includes(after_2.tool), after_2);
await ev(`(() => { newProject(Formats.java_block); })()`);
check('   a format without meshes does not offer the tab', await ev(`!Condition(Modes.options.block.condition)`));

// B. into the tab
// A tab remembers its tool for the whole session, so a reused app would come in on whatever the last run left
await ev(`(() => { let free = ModelProject.all.find(p => p.format.id == 'free'); free.select(); BarItems.move_tool.select(); delete Modes.options.block.tool; Modes.options.block.select(); })()`);
let inside = await json(state);
check('B. the tab counts as Edit for behaviour and opens on the Tile Brush', inside.mode == 'block' && inside.edit && inside.block && inside.tool == 'dew_tile_brush', inside);
let block_shown = await json(shown);
check('   its toolbar is move, resize, rotate and the nine tools, nothing else', JSON.stringify(block_shown.slice().sort()) == JSON.stringify(['move_tool', 'resize_tool', 'rotate_tool', ...BLOCK_TOOLS].sort()), block_shown);
let leaks = await json(`JSON.stringify(${JSON.stringify(EDIT_ONLY)}.filter(id => BarItems[id] && Condition(BarItems[id].condition)))`);
check('   the Edit tools and the selection mode control stay out', leaks.length == 0 && await ev(`!Condition(BarItems.selection_mode.condition)`), leaks);
let panels = await json(`JSON.stringify(['outliner', 'uv', 'textures', 'element', 'transform', 'dew_materials'].filter(id => !Condition(Panels[id].condition)))`);
check('   outliner, UV, textures, element and the Materials panel are available', panels.length == 0, panels);
for (let [key, tool] of [['1', 'dew_tile_select'], ['2', 'dew_whole_block'], ['4', 'dew_texture_brush'], ['5', 'dew_paint_bucket'], ['6', 'dew_terrain'], ['3', 'dew_tile_brush']]) {
	await press(key);
	let picked = await ev(`Toolbox.selected.id`);
	check(`   ${key} picks ${tool}`, picked == tool, picked);
}
let rules = await json(view);
check('   back faces culled, game grid, 4 unit step and the fabric size limit', rules.front && rules.dew_grid && rules.step == 4 && rules.limiter && rules.tint > 0, rules);

// C. painting in a generic project: a click with the Tile Brush on the work plane lays a tile
await ev(`(() => { let p = Preview.selected; p.controls.target.set(64, 0, 64); p.camera.position.set(64, 300, 120); p.controls.update(); p.render(); })()`);
await sleep(150);
await ev(`Preview.selected.render()`);
let before = await ev(`Mesh.all.reduce((n, m) => n + Object.keys(m.faces).length, 0)`);
await click([88, 0, 88]);
let after = await ev(`Mesh.all.reduce((n, m) => n + Object.keys(m.faces).length, 0)`);
check('C. the Tile Brush paints in a generic project', after > before, {before, after});
await ev(`Undo.undo()`);
check('   and the stroke is one undo entry', await ev(`Mesh.all.reduce((n, m) => n + Object.keys(m.faces).length, 0)`) == before);

// D. a fabric cube: the resize limit holds here, and a material from the manifest goes on it
let cube = await json(`(() => { let c = new Cube({name: 'wall', from: [0, 0, 32], to: [32, 32, 36]}).init(); c.select();
	c.resize(-3, 2, false);	// 4 thick, asked to be 1
	Canvas.updateView({elements: [c], element_aspects: {geometry: true}});
	return JSON.stringify({thick: c.to[2] - c.from[2]}); })()`);
check('D. a cube cannot be resized under the fabric minimum in the tab', cube.thick == 4, cube);
let material = await json(`(async () => { let list = DEWMaterial.getMaterials(); if (!list.length) return JSON.stringify({manifest: false});
	let name = list[0].name; let c = Cube.all.find(c => c.name == 'wall');
	await DEWMaterial.applyMaterial([c], name, {force: true});
	let keys = DEWMaterial.tagKeys();
	return JSON.stringify({manifest: true, name, tagged: c.game && c.game[keys.material], atlas: !!DEWMaterial.getAtlas(false), brush: Condition(BarItems.dew_material_brush.condition), apply: Condition(BarItems.dew_apply_material?.condition ?? true)}); })()`);
if (material.manifest) check('   a material from the game manifest applies to it, brush and panel on hand', material.tagged == material.name && material.atlas && material.brush, material);
else console.log('SKIP  the game manifest is not readable on this machine');

// E. out to Edit: the rules go with the tab, and each tab keeps its own tool
await press('2');
await ev(`Modes.options.edit.select()`);
let outside = await json(state);
check('E. Edit comes back on its own tool', outside.mode == 'edit' && outside.edit && !outside.block && outside.tool == 'move_tool', outside);
let edit_rules = await json(view);
check('   with both sides drawn, the stock grid, the user step and no size limit', !edit_rules.front && !edit_rules.dew_grid && edit_rules.step == edit_rules.user_step && !edit_rules.limiter && edit_rules.tint == 0, edit_rules);
await press('2');
check('   2 still picks no tile tool out here', !BLOCK_TOOLS.includes(await ev(`Toolbox.selected.id`)));
await ev(`Modes.options.block.select()`);
check('   and the tab remembers Whole Block', await ev(`Toolbox.selected.id`) == 'dew_whole_block');
await ev(`Modes.options.paint.select()`);
let paint = await json(state);
check('   Paint is not Edit after leaving the tab', paint.mode == 'paint' && !paint.edit && !paint.block, paint);

// F. a DEW scene is a preset now: it opens in the tab, with its scale figure and starter tile
let dew = await json(`(() => { newProject(Formats.dew_scene); return JSON.stringify({mode: Modes.id, tool: Toolbox.selected.id, figure: Cube.all.some(c => c.name == DEW.FIGURE_NAME), tiles: Mesh.all.length,
	export_scale: Project.export_options.gltf?.scale, front: Canvas.getRenderSide() == THREE.FrontSide}); })()`);
check('F. a new DEW scene opens in the tab', dew.mode == 'block' && dew.figure && dew.tiles == 1 && dew.export_scale == 16 && dew.front, dew);
await ev(`Modes.options.edit.select()`);
check('   and its Edit tab is plain Edit', (await json(view)).front === false);
// G. switching project tabs carries nothing over: the generic project is where it was left, in Paint
await ev(`(() => { ModelProject.all.find(p => p.format.id == 'free').select(); })()`);
let back = await json(state);
check('G. each project keeps its own tab', back.mode == 'paint' && !back.block, back);

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
ws.close();
