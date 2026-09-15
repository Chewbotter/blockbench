// Handoff section 8: one small room built with the material brushes and saved into the game repo, with the
// report the game side asked for: the save path, every cube a multiple of 4, and one tagged cube's game key and
// a face uv as the file holds them. Sizes and positions are on the 4 grid; the door is 32 x 48, the glass 4 thick.
import fs from 'fs';
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

// name, material, from, to, optional {origin, rotation}
const ROOM = [
	['floor.concrete', 'concrete', [0, -4, 0], [192, 0, 192]],
	['wall.north', 'brick', [0, 0, 0], [192, 64, 8]],
	['wall.west', 'brick', [0, 0, 8], [8, 64, 192]],
	// East wall with a window opening x 184..192, y 24..48, z 72..120
	['wall.east.a', 'brick', [184, 0, 8], [192, 64, 72]],
	['wall.east.b', 'brick', [184, 0, 120], [192, 64, 184]],
	['wall.east.sill', 'brick', [184, 0, 72], [192, 24, 120]],
	['wall.east.lintel', 'brick', [184, 48, 72], [192, 64, 120]],
	['frame.bottom', 'metal', [184, 24, 72], [192, 28, 120]],
	['frame.top', 'metal', [184, 44, 72], [192, 48, 120]],
	['frame.left', 'metal', [184, 28, 72], [192, 44, 76]],
	['frame.right', 'metal', [184, 28, 116], [192, 44, 120]],
	['pane.glass', 'glass', [184, 28, 76], [188, 44, 116]],	// 4 thick, flush with the outer face: the wall is 8 thick, so a centred pane would sit at x 186, off the 4 grid
	// South wall, stucco, with a door opening x 80..112 (32 wide), y 0..48
	['wall.south.a', 'stucco', [8, 0, 184], [80, 64, 192]],
	['wall.south.b', 'stucco', [112, 0, 184], [184, 64, 192]],
	['wall.south.lintel', 'stucco', [80, 48, 184], [112, 64, 192]],
	// Roof: a wooden slab pitched 30 degrees about the north eave, long enough to reach past the south wall
	['roof.wood', 'wood', [0, 64, 0], [192, 68, 224], {origin: [0, 64, 0], rotation: [30, 0, 0]}],
];

await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove()); unselectAllElements(); updateSelection();
	Project.name = 'test_room';
	let group = new Group({name: 'fabric'}).init(); group.game = {kind: 'fabric'};
	return true; })()`);
await sleep(400);
for (const [name, material, from, to, extra = {}] of ROOM) {
	await ev(`(() => { let c = new Cube({name: ${JSON.stringify(name)}, from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)}, origin: ${JSON.stringify(extra.origin || from)}, rotation: ${JSON.stringify(extra.rotation || [0, 0, 0])}}).init(); c.box_uv = false;
		c.addTo(Group.all[0]); return true; })()`);
	await ev(`DEWMaterial.applyMaterial([Cube.all.find(c => c.name == ${JSON.stringify(name)})], ${JSON.stringify(material)})`);
}
await sleep(300);
console.log('built:', await ev(`JSON.stringify({cubes: Cube.all.length, atlas: DEWMaterial.atlasUsage(), group_kind: Group.all[0].game})`));

const saved_path = await ev(`DEWMaterial.saveToGame()`);
await sleep(800);
console.log('saved to:', saved_path);
const file = JSON.parse(fs.readFileSync(saved_path, 'utf8'));
const cubes = file.elements.filter(e => e.type == 'cube');
const bad = cubes.filter(e => [0, 1, 2].some(i => { let s = Math.abs(e.to[i] - e.from[i]); return s % 4 != 0 || s < 4 || e.from[i] % 4 != 0; })).map(e => e.name);
const uv_overlaps = (() => { let list = []; for (let e of cubes) for (let k in e.faces) { let f = e.faces[k]; list.push({x: Math.min(f.uv[0], f.uv[2]), y: Math.min(f.uv[1], f.uv[3]), w: Math.abs(f.uv[2] - f.uv[0]), h: Math.abs(f.uv[3] - f.uv[1])}); }
	let n = 0; for (let a of list) for (let b of list) if (a != b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) n++; return n / 2; })();
console.log('REPORT for the game side');
console.log('  file:', saved_path);
console.log('  format:', file.meta.model_format, ' cubes:', cubes.length, ' materials:', JSON.stringify([...new Set(cubes.map(e => e.game?.material))]));
console.log('  every cube size and position a multiple of 4, size at least 4:', bad.length ? 'NO: ' + bad.join(', ') : 'yes');
console.log('  atlas regions overlapping:', uv_overlaps, ' texture:', JSON.stringify(file.textures.map(t => ({name: t.name, width: t.width, height: t.height, uv_width: t.uv_width, embedded: !!t.source}))));
console.log('  group tags (model.groups, format 5.0):', JSON.stringify((file.groups || []).map(g => ({name: g.name, game: g.game}))), ' outliner children:', file.outliner.map(n => typeof n == 'object' ? n.children.length : 1));
const wall = cubes.find(e => e.name == 'wall.north');
console.log('  one tagged cube, wall.north:', JSON.stringify({name: wall.name, uuid: wall.uuid, from: wall.from, to: wall.to, game: wall.game, south_uv: wall.faces.south.uv, south_texture: wall.faces.south.texture}));
const roof = cubes.find(e => e.name == 'roof.wood');
console.log('  the pitched roof:', JSON.stringify({from: roof.from, to: roof.to, origin: roof.origin, rotation: roof.rotation, game: roof.game}));
console.log('  the pane:', JSON.stringify({from: cubes.find(e => e.name == 'pane.glass').from, to: cubes.find(e => e.name == 'pane.glass').to, game: cubes.find(e => e.name == 'pane.glass').game}));
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
