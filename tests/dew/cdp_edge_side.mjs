// Which of the two cells meeting along an edge the tile brush paints.
// The default closes a gap; Tab takes the other one. A wall started on a floor must still land above it.
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
const hover = async world => { await mouse('mouseMoved', await screen(...world), { button: 'none' }); await sleep(90); };
async function click(world) {
	const at = await screen(...world);
	await mouse('mouseMoved', at, { button: 'none' }); await sleep(60);
	await mouse('mousePressed', at, { buttons: 1 }); await sleep(60);
	await mouse('mouseReleased', at); await sleep(160);
}
async function tab() {
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
	await sleep(140);
}
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); return true; })()`);
	await sleep(160);
};
// Tiles lying in one plane, as the corner each one starts at
const tilesIn = (axis, depth) => `(() => { let out = []; let i = {x: 0, y: 1, z: 2}['${axis}'];
	let plane = {y: ['x', 'z'], x: ['z', 'y'], z: ['x', 'y']}['${axis}'];
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices(); if (vs.length != 4) continue;
		let n = f.getNormal(true); if (Math.abs(n[i]) < 0.99) continue;
		let ps = vs.map(k => ({x: m.vertices[k][0], y: m.vertices[k][1], z: m.vertices[k][2]}));
		if (Math.abs(ps[0]['${axis}'] - ${depth}) > 0.01) continue;
		out.push(m.name + ' ' + Math.min(...ps.map(p => p[plane[0]])) + ',' + Math.min(...ps.map(p => p[plane[1]]))); }
	return JSON.stringify(out.sort()); })()`;
const ghostCell = `(() => { let g = Canvas.scene.getObjectByName('dew_tile_ghost');
	if (!g) return 'none';
	let b = new THREE.Box3().setFromObject(g); let r = v => Math.round(v * 10) / 10;
	return [r(b.min.x), r(b.min.y), r(b.min.z)].join(',') + ' to ' + [r(b.max.x), r(b.max.y), r(b.max.z)].join(','); })()`;

// Ground, a wall standing on it at x 32 facing +x, and a strip of upper floor on the -x side:
// the gap to close is x 16..32 at y 32, the open air is x 32..48
await ev(`(() => {
	newProject(Formats.dew_scene);
	window.__build = (name, list) => { let m = new Mesh({name, vertices: {}}); let map = {};
		let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
		let axes = {x: ['z', 'y'], y: ['x', 'z'], z: ['x', 'y']};
		for (let [axis, depth, sign, u0, v0, nu, nv] of list) { let [ua, va] = axes[axis];
			for (let u = u0; u < u0 + nu * 16; u += 16) for (let v = v0; v < v0 + nv * 16; v += 16) {
				let pt = (du, dv) => { let p = {}; p[axis] = depth; p[ua] = u + du; p[va] = v + dv; return [p.x, p.y, p.z]; };
				let f = new MeshFace(m, {vertices: [pt(0,0), pt(16,0), pt(16,16), pt(0,16)].map(vert), texture: false});
				m.addFaces(f); if (f.getNormal(true)[{x: 0, y: 1, z: 2}[axis]] * sign < 0) f.invert(); } }
		m.init(); return m; };
	__build('ground', [['y', 0, 1, 0, 0, 4, 4]]);
	__build('wall', [['x', 32, 1, 0, 0, 4, 2]]);
	__build('top', [['y', 32, 1, 0, 0, 1, 4]]);
	unselectAllElements(); return true; })()`);
await ev(`(() => { BarItems.dew_tile_brush.select(); let s = DEWTileBrush.state; s.size = 16; s.axis = 'y'; s.depth = 32; return true; })()`);
await sleep(200);
await camera(24, 24, 32, 150, 90, 150);
console.log('start, tiles at y 32:', await ev(tilesIn('y', 32)), ' expect the top strip at x 0 only');

await hover([32, 30, 24]);
await hover([32, 30, 24]);
console.log('A. ghost with the cursor on the wall under its top edge:', await ev(ghostCell));
console.log('   expect x 16 to 32: the gap beside the strip, not x 32 to 48 out in the air');

await click([32, 30, 24]);
console.log('B. click paints:', await ev(tilesIn('y', 32)), ' expect a new tile at 16,16');

await ev(`Undo.undo(); true`);
await tab();
await hover([32, 30, 24]);
console.log('C. after Tab:', await ev(ghostCell), ' expect x 32 to 48, the far side');
await click([32, 30, 24]);
console.log('D. click paints:', await ev(tilesIn('y', 32)), ' expect a new tile at 32,16');
await ev(`Undo.undo(); true`);
await tab();
console.log('E. Tab back:', await ev(`DEWTileBrush.state.edge_flip`), ' expect false');

// The case the nudge was there for in the first place
await ev(`(() => { let s = DEWTileBrush.state; s.axis = 'x'; s.depth = 48; return true; })()`);
await sleep(150);
await camera(32, 8, 32, 150, 60, 150);
await hover([48, 0, 24]);
await hover([48, 0, 24]);
console.log('F. wall plane x 48, cursor on the ground:', await ev(ghostCell), ' expect y 0 to 16, above the floor');
await click([48, 0, 24]);
console.log('G. click paints:', await ev(tilesIn('x', 48)), ' expect one tile at 16,0 (z 16, y 0), never y -16');

// Tab belongs to the ramp tool's own action while that tool is up, so the two never both fire
console.log('H. Tab conditions:', await ev(`(() => { let out = {};
	BarItems.dew_tile_brush.select(); out.brush = {edge: Condition(BarItems.dew_tile_edge_side.condition), ramp: Condition(BarItems.dew_ramp_direction.condition)};
	BarItems.dew_ramp.select(); out.ramp_tool = {edge: Condition(BarItems.dew_tile_edge_side.condition), ramp: Condition(BarItems.dew_ramp_direction.condition)};
	out.conflict = {edge: !!BarItems.dew_tile_edge_side.keybind.conflict, ramp: !!BarItems.dew_ramp_direction.keybind.conflict};
	BarItems.dew_tile_brush.select(); return JSON.stringify(out); })()`));
console.log('   expect brush {edge true, ramp false}, ramp_tool {edge false, ramp true}, and neither keybind in conflict');

console.log('page errors:', errors.length ? errors : 'none');
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_edge_side.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
