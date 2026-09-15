// Material brushes (handoff rev d.o, sections 3 to 5): tags ride through save and load, fills land at 1 texel per
// unit in regions no two faces share, the pattern carries on across touching cubes, refills keep hand paint
// behind a confirmation, name fallbacks tag old files, and the reference file survives a round trip.
import fs from 'fs';
import path from 'path';
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type == 'page' && t.url.includes('index.html')) ?? targets.find(t => t.type == 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method == 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result.result.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { if (await ev('typeof Blockbench != "undefined" && !!window.Preview && Preview.all.length > 0')) break; await sleep(500); }
await send('Runtime.enable');

const screen = async (x, y, z) => JSON.parse(await ev(`(() => { let p = Preview.selected; let v = new THREE.Vector3(${x}, ${y}, ${z}).project(p.camera); let r = p.canvas.getBoundingClientRect(); return JSON.stringify([r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]); })()`));
const mouse = (type, [x, y], extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
async function click(world, modifiers = 0) {
	const at = await screen(...world);
	for (let i = 0; i < 2; i++) { await mouse('mouseMoved', at, { button: 'none', modifiers }); await sleep(80); }
	await mouse('mousePressed', at, { buttons: 1, modifiers }); await sleep(70);
	await mouse('mouseReleased', at, { modifiers }); await sleep(400);
}
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); if (p.render) p.render(); return true; })()`);
	await sleep(200);
};
const cube = (name, from, to, extra = {}) => `(() => { let c = new Cube({name: '${name}', from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)}, origin: ${JSON.stringify(extra.origin || from)}, rotation: ${JSON.stringify(extra.rotation || [0, 0, 0])}}).init(); c.box_uv = false; return c.uuid; })()`;
// Per cube: tag, every face's uv rect and texture, sizes as multiples of 4
const report = `(() => { let keys = DEWMaterial.tagKeys(); let out = {};
	for (let c of Cube.all) { let size = [0, 1, 2].map(i => c.to[i] - c.from[i]);
		out[c.name] = {material: c.game && c.game[keys.material], size, mult4: size.every(v => v % 4 == 0 && v >= 4),
			faces: Object.fromEntries(Object.entries(c.faces).map(([k, f]) => [k, {uv: f.uv.slice(), tex: f.texture ? Texture.all.find(t => t.uuid == f.texture)?.name : f.texture}]))}; }
	return JSON.stringify(out); })()`;
// Do any two atlas regions overlap, and does each face's region match its size at 1 texel per unit
const regions = `(() => { let atlas = DEWMaterial.getAtlas(false); let list = [];
	for (let c of Cube.all) for (let k in c.faces) { let f = c.faces[k]; if (!atlas || f.texture != atlas.uuid) continue;
		let dims = {north: [0, 1], south: [0, 1], east: [2, 1], west: [2, 1], up: [0, 2], down: [0, 2]}[k]; let size = [0, 1, 2].map(i => c.to[i] - c.from[i]);
		list.push({name: c.name + '.' + k, x: Math.min(f.uv[0], f.uv[2]), y: Math.min(f.uv[1], f.uv[3]), w: Math.abs(f.uv[2] - f.uv[0]), h: Math.abs(f.uv[3] - f.uv[1]), want: [size[dims[0]], size[dims[1]]]}); }
	let overlaps = 0; for (let a of list) for (let b of list) if (a != b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++;
	let wrong = list.filter(r => r.w != r.want[0] || r.h != r.want[1]).map(r => r.name);
	return JSON.stringify({faces: list.length, overlaps: overlaps / 2, wrong_size: wrong, atlas: atlas ? [atlas.width, atlas.uv_width] : null, usage: DEWMaterial.atlasUsage()}); })()`;
await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove()); unselectAllElements(); updateSelection(); return true; })()`);
await sleep(400);
console.log('A. manifest:', await ev(`JSON.stringify({materials: DEWMaterial.getMaterials().map(m => m.name), keys: DEWMaterial.tagKeys(), panel: !!Panels.dew_materials, tool: Toolbars.tools.children.some(c => c.id == 'dew_material_brush')})`));
console.log('   expect the eight materials from materials.json, keys material / kind, panel and tool present');

// Two brick walls touching end to end at x 128, on the 4 grid
await ev(cube('wall_a', [0, 0, 0], [128, 64, 8]));
await ev(cube('wall_b', [128, 0, 0], [256, 64, 8]));
await ev(`DEWMaterial.applyMaterial(Cube.all, 'brick')`);
await sleep(300);
console.log('B. brick on two walls:', await ev(report));
console.log('   expect material brick on both, every face textured atlas, south uv 128 x 64, up 128 x 8, east 8 x 64');
console.log('   regions:', await ev(regions), ' expect 12 faces, 0 overlaps, no wrong sizes, atlas 512');

// The pattern continues across the seam: the south face texel at world x 127 and x 128 are consecutive tile columns
console.log('C. seam continuity:', await ev(`(() => { let atlas = DEWMaterial.getAtlas(false); let fill = DEWMaterial.manifest_state.fills.get('brick');
	let px = (c, k, i, j) => { let f = c.faces[k]; let x = Math.min(f.uv[0], f.uv[2]) + i, y = Math.min(f.uv[1], f.uv[3]) + j; return [...atlas.ctx.getImageData(x, y, 1, 1).data]; };
	let a = Cube.all.find(c => c.name == 'wall_a'), b = Cube.all.find(c => c.name == 'wall_b');
	// south face reads left to right along +x, so wall_a's last column is x 127 and wall_b's first is x 128
	let tile = (s, t) => { let i = (((s % 64) + 64) % 64), j = (((t % 64) + 64) % 64); let o = (j * 64 + i) * 4; return [...fill.data.slice(o, o + 4)]; };
	// row 0 of the face is the top edge (y 63): v runs down the face
	return JSON.stringify({a_last: px(a, 'south', 127, 0), tile_127: tile(127, 63), b_first: px(b, 'south', 0, 0), tile_128: tile(128, 63), a_first_row5: px(a, 'south', 0, 5), tile_0_58: tile(0, 58)}); })()`));
console.log('   expect a_last == tile_127, b_first == tile_128, a_first_row5 == tile_0_58: the fill is the tile at cube-space position, rows counted down from the top');

// Hand paint: a texel painted over the fill makes the refill ask, force skips the question and repaints it
await ev(`(() => { let atlas = DEWMaterial.getAtlas(false); let c = Cube.all.find(c => c.name == 'wall_a'); let f = c.faces.south;
	atlas.edit(canvas => { let ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff00ff'; ctx.fillRect(Math.min(f.uv[0], f.uv[2]) + 3, Math.min(f.uv[1], f.uv[3]) + 3, 1, 1); }, {no_undo: true}); return true; })()`);
console.log('D. painted texel detected:', await ev(`JSON.stringify(Cube.all.map(c => DEWMaterial.hasHandPaint(c, 'south', DEWMaterial.getAtlas(false))))`), ' expect [true, false]');
await ev(`DEWMaterial.applyMaterial([Cube.all.find(c => c.name == 'wall_a')], 'stucco', {force: true})`);
await sleep(300);
console.log('   forced refill as stucco:', await ev(`(() => { let c = Cube.all.find(c => c.name == 'wall_a'); let f = c.faces.south; let atlas = DEWMaterial.getAtlas(false);
	return JSON.stringify({material: c.game.material, uv: f.uv, texel: [...atlas.ctx.getImageData(Math.min(f.uv[0], f.uv[2]) + 3, Math.min(f.uv[1], f.uv[3]) + 3, 1, 1).data], hand_paint_now: DEWMaterial.hasHandPaint(c, 'south', atlas)}); })()`));
console.log('   expect material stucco, the same uv region reused, the magenta texel gone, hand_paint_now false');
await ev(`Undo.undo(); true`);
console.log('   undo:', await ev(`JSON.stringify({material: Cube.all.find(c => c.name == 'wall_a').game.material})`), ' expect brick');

// The brush tool: click a cube in the viewport
await ev(cube('floor', [0, -4, 8], [256, 0, 136]));
await camera(128, 0, 72, 128, 260, 300);
await ev(`(() => { DEWMaterial.selectMaterial('concrete'); BarItems.dew_material_brush.select(); return true; })()`);
await sleep(200);
await click([128, 0, 72]);
await sleep(300);
console.log('E. brush click on the floor:', await ev(`JSON.stringify({material: Cube.all.find(c => c.name == 'floor').game?.material, undo: Undo.history.at(-1)?.action})`), ' expect concrete, undo "Apply concrete"');
console.log('   regions:', await ev(regions), ' expect 18 faces, 0 overlaps, atlas still 512 at about 41% used');

// A face too large for the free space grows the atlas
await ev(cube('slab', [0, 200, 0], [400, 204, 400]));
await ev(`DEWMaterial.applyMaterial([Cube.all.find(c => c.name == 'slab')], 'wood')`);
await sleep(400);
console.log('   a 400 x 400 slab grows it:', await ev(regions), ' expect 24 faces, 0 overlaps, atlas 1024 with uv_width 1024');
console.log('   slab top texel matches the wood tile at its cube-space position:', await ev(`(() => { let atlas = DEWMaterial.getAtlas(false); let fill = DEWMaterial.manifest_state.fills.get('wood'); let c = Cube.all.find(c => c.name == 'slab'); let f = c.faces.up;
	let x = Math.min(f.uv[0], f.uv[2]), y = Math.min(f.uv[1], f.uv[3]); let px = [...atlas.ctx.getImageData(x + 70, y + 9, 1, 1).data];
	let tile = (s, t) => { let o = ((t % 64) * 64 + (s % 64)) * 4; return [...fill.data.slice(o, o + 4)]; };
	return JSON.stringify({px, tile: tile(70, 9)}); })()`), ' expect px == tile: the up face reads +x right and +z down from the cube corner at 0,0');
await ev(`(() => { Cube.all.find(c => c.name == 'slab').remove(); return true; })()`);
await click([128, 0, 72], 1);
console.log('   alt picks it up:', await ev(`DEWMaterial.manifest_state.selected`), ' expect concrete');

// Save and reload: tags and uvs survive, empty tags are stripped, name fallbacks tag an untagged cube
await ev(cube('post.wood', [300, 0, 0], [316, 64, 16]));
await ev(`(() => { let g = new Group({name: 'prop.crate'}).init(); return true; })()`);
const saved = await ev(`(() => { let json = Codecs.project.compile(); let model = JSON.parse(json); let wall = model.elements.find(e => e.name == 'wall_a'); let post = model.elements.find(e => e.name == 'post.wood');
	return JSON.stringify({wall_game: wall.game, wall_south_uv: wall.faces.south.uv, post_game: post.game, textures: model.textures.map(t => [t.name, t.width, t.uv_width, !!t.source]), elements: model.elements.length}); })()`);
console.log('F. compiled file:', saved);
console.log('   expect wall_game {material: brick}, post_game undefined (empty tag stripped), one atlas texture 1024 with an embedded source');
const tmp = path.join(process.env.TEMP || '.', 'dew_material_roundtrip.bbmodel');
fs.writeFileSync(tmp, await ev(`Codecs.project.compile()`));
await ev(`new Promise(done => Blockbench.read([${JSON.stringify(tmp)}], {readtype: 'text'}, files => { loadModelFile(files[0]); done(true); }))`);
await sleep(800);
console.log('G. after reload:', await ev(`(() => { let keys = DEWMaterial.tagKeys(); let wall = Cube.all.find(c => c.name == 'wall_a'); let post = Cube.all.find(c => c.name == 'post.wood'); let g = Group.all.find(g => g.name == 'prop.crate');
	return JSON.stringify({wall: wall.game, wall_uv: wall.faces.south.uv, post: post.game, crate: g && g.game, atlas: DEWMaterial.getAtlas(false)?.width}); })()`));
console.log('   expect wall {material: brick} with its uv, post {material: wood} from its name, crate {kind: prop} from its name, atlas 1024');

// The reference file the game side wrote round-trips with its tags
const ref = 'D:/Work/DistantEarlyWarning/distantearly_game/models/wall_starter/Wall_starter.bbmodel';
await ev(`new Promise(done => Blockbench.read([${JSON.stringify(ref)}], {readtype: 'text'}, files => { loadModelFile(files[0]); done(true); }))`);
await sleep(800);
console.log('H. reference file:', await ev(`(() => { let c = Cube.all[0]; let model = JSON.parse(Codecs.project.compile()); let e = model.elements[0];
	return JSON.stringify({format: Format.id, loaded_game: c.game, saved_game: e.game, saved_uv: e.faces.south.uv, group: model.groups && model.groups[0] && model.groups[0].name}); })()`));
console.log('   expect loaded and saved game {material: brick, kind: fabric}, south uv [0,0,128,64], group fabric');

console.log('page errors:', errors.length ? errors : 'none');
ws.close();
