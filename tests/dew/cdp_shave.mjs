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

const screen = async (x, y, z) => JSON.parse(await ev(`(() => { let p = Preview.selected; let v = new THREE.Vector3(${x}, ${y}, ${z}).project(p.camera); let r = p.canvas.getBoundingClientRect(); return JSON.stringify([r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]); })()`));
const mouse = (type, [x, y], extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
const hover = async world => { await mouse('mouseMoved', await screen(...world), { button: 'none' }); await sleep(80); };
async function click(world) {
	const at = await screen(...world);
	await mouse('mouseMoved', at, { button: 'none' }); await sleep(40);
	await mouse('mousePressed', at, { buttons: 1 }); await sleep(40);
	await mouse('mouseReleased', at); await sleep(120);
}
async function key(letter) {
	const code = letter.toUpperCase().charCodeAt(0);
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await sleep(80);
}
// The camera matrix that world points project through only updates on render, so wait a frame before clicking
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); return true; })()`);
	await sleep(150);
};
// Face summary of a mesh: count, triangles with their normals and corners, diagonal faces with corners, UVs and texture
const info = name => `(() => { let m = Mesh.all.find(m => m.name == '${name}'); let r = v => Math.round(v * 100) / 100;
	let faces = Object.values(m.faces); let world = k => m.vertices[k].map(r);
	let tris = faces.filter(f => f.vertices.length == 3).map(f => ({n: f.getNormal(true).map(r).join(','), p: f.vertices.map(k => world(k).join(',')).sort()}));
	let diag = faces.filter(f => { let n = f.getNormal(true); return n.filter(v => Math.abs(v) > 0.01).length == 2; })
		.map(f => ({n: f.getNormal(true).map(r).join(','), p: f.vertices.map(k => world(k).join(',') + ' uv ' + f.uv[k].map(r).join(',')), textured: !!f.texture}));
	let corner_verts = Object.values(m.vertices).filter(v => v[0] == ${name == 'box' ? 32 : 256} && v[2] == ${name == 'box' ? 32 : 64}).length;
	return JSON.stringify({faces: faces.length, tris, diag, corner_line_vertices: corner_verts}); })()`;

// box: x 0..32, z 0..32, y 0..48, half tiles on four sides and the top, no bottom; +z side textured with atlas cell (16,0)
// floor: a flat plane; box2: 64 cube of half tiles for the full-size cut
await ev(`(() => {
	newProject(Formats.dew_scene);
	window.__build = (name, list) => { let m = new Mesh({name, vertices: {}}); let map = {};
		let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
		let axes = {x: ['z', 'y'], y: ['x', 'z'], z: ['x', 'y']};
		for (let [axis, depth, sign, u0, v0, nu, nv] of list) { let [ua, va] = axes[axis];
			for (let u = u0; u < u0 + nu * 16; u += 16) for (let v = v0; v < v0 + nv * 16; v += 16) {
				let pt = (du, dv) => { let p = {}; p[axis] = depth; p[ua] = u + du; p[va] = v + dv; return [p.x, p.y, p.z]; };
				let f = new MeshFace(m, {vertices: [pt(0,0), pt(16,0), pt(16,16), pt(0,16)].map(vert), texture: false});
				m.addFaces(f); if (f.getNormal(true)[{x: 0, y: 1, z: 2}[axis]] * sign < 0) f.invert();
			} }
		m.init(); return m; };
	__build('box', [['x', 32, 1, 0, 0, 2, 3], ['x', 0, -1, 0, 0, 2, 3], ['z', 32, 1, 0, 0, 2, 3], ['z', 0, -1, 0, 0, 2, 3], ['y', 48, 1, 0, 0, 2, 2]]);
	__build('floor', [['y', 0, 1, 64, 0, 4, 2]]);
	__build('box2', [['x', 256, 1, 0, 0, 4, 4], ['x', 192, -1, 0, 0, 4, 4], ['z', 64, 1, 192, 0, 4, 4], ['z', 0, -1, 192, 0, 4, 4], ['y', 64, 1, 192, 0, 4, 4]]);
	unselectAllElements(); return true; })()`);
await ev(`(() => { BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(400);
await ev(`(() => { let t = Texture.all[0]; let m = Mesh.all.find(m => m.name == 'box');
	for (let f of Object.values(m.faces)) { let n = f.getNormal(true); if (Math.round(n[2]) != 1) continue;
		let ps = f.vertices.map(k => m.vertices[k]); let x0 = Math.min(...ps.map(p => p[0])), y0 = Math.min(...ps.map(p => p[1]));
		f.texture = t.uuid; f.vertices.forEach(k => f.uv[k] = [16 + (m.vertices[k][0] - x0), 16 - (m.vertices[k][1] - y0)]); }
	Canvas.updateView({elements: [m], element_aspects: {faces: true, uv: true}}); return true; })()`);
await camera(16, 24, 16, 16 + 90, 24 + 60, 16 + 110);
await ev(`(() => { BarItems.dew_shave.select(); return true; })()`);
await key('c');   // half tiles
console.log('setup:', await ev(`JSON.stringify({tool: Toolbox.selected.id, size: DEWTileBrush.state.size, order: (ids => ids.slice(ids.indexOf('dew_tile_brush'), ids.indexOf('dew_tile_brush') + 3))(Toolbars.tools.children.map(c => c.id))})`), ' expect dew_shave after dew_tile_brush');
console.log('start:', await ev(info('box')));

await hover([30, 24, 32]);
console.log('A. hover near the +z/+x corner:', await ev(`!!Canvas.scene.getObjectByName('dew_tile_ghost')`), ' expect true');
await camera(96, 0, 16, 96, 90, 120);
await hover([88, 0, 17]);
await camera(16, 24, 16, 16 + 90, 24 + 60, 16 + 110);
console.log('B. hover on the flat floor, no corner anywhere on the block:', await ev(`!!Canvas.scene.getObjectByName('dew_tile_ghost')`), ' expect false');

await click([30, 24, 32]);
console.log('C. shave the middle stretch from the +z side:', await ev(info('box')));
console.log('   expect 29 faces; diagonal 16,16,32 / 16,32,32 / 32,32,16 / 32,16,16 with uvs 16,16 / 16,0 / 32,0 / 32,16, textured; triangles at y 16 (up) and y 32 (down)');

await click([32, 8, 30]);
console.log('D. shave the bottom stretch from the +x side:', await ev(info('box')));
console.log('   expect 27 faces; 2 diagonals, the new one untextured; only the y 32 triangle left (the y 16 one removed, open bottom needs none)');

await click([30, 40, 32]);
console.log('E. shave the top stretch into the top face:', await ev(info('box')));
console.log('   expect 25 faces; 3 diagonals; one triangle: the top face corner trimmed to 16,48,16 / 16,48,32 / 32,48,16 facing up; no corner line vertices');

await ev(`Undo.undo(); true`);
console.log('F. undo the last shave:', await ev(`Object.keys(Mesh.all.find(m => m.name == 'box').faces).length`), ' expect 27');

let history = await ev(`Undo.history.length`);
await camera(96, 0, 16, 96, 90, 120);
await click([88, 0, 17]);
console.log('G. click on a flat plane:', await ev(`JSON.stringify({faces: Object.keys(Mesh.all.find(m => m.name == 'floor').faces).length, new_undo_steps: Undo.history.length - ${history}})`), ' expect 8 faces, 0 steps');

await camera(224, 32, 32, 224 + 150, 32 + 110, 32 + 190);
await key('c');   // full tiles
await click([254, 48, 64]);
console.log('H. full-size shave on box2 (top stretch):', await ev(info('box2')));
console.log('   expect 73 faces; one 32-deep diagonal; triangles: closing y 32 (up), and two split top quads (up)');

await camera(16, 24, 16, 16 + 90, 24 + 60, 16 + 110);
await hover([30, 8, 32]);
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_shave.png', Buffer.from(shot.result.data, 'base64'));
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
