// Terrain Brush: raising and lowering ground tiles, the ground around following as ramps and triangles, hills
// spreading at one step per half cell, drags laying an even ridge, and pinned corners (cluster border, walls).
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
	await mouse('mouseReleased', at, { modifiers }); await sleep(250);
}
async function dragWorld(from, to, steps = 12) {
	const a = await screen(...from), b = await screen(...to);
	for (let i = 0; i < 2; i++) { await mouse('mouseMoved', a, { button: 'none' }); await sleep(80); }
	await mouse('mousePressed', a, { buttons: 1 }); await sleep(70);
	for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps], { buttons: 1 }); await sleep(40); }
	await mouse('mouseReleased', b); await sleep(250);
}
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); if (p.render) p.render(); return true; })()`);
	await sleep(200);
};
// Ground summary of one element: heights at given corners, quad and triangle counts among faces facing up, the
// largest height step along a half cell edge, and anything that does not face up
const ground = (name, corners) => `(() => { let m = Mesh.all.find(m => m.name == '${name}'); if (!m) return 'no ${name}';
	let at = {}; for (let [x, z] of ${JSON.stringify(corners)}) at[x + ',' + z] = Object.values(m.vertices).filter(p => p[0] == x && p[2] == z).map(p => p[1]);
	let quads = 0, tris = 0, steepest = 0, other = [];
	for (let f of Object.values(m.faces)) { let n = f.getNormal(true);
		if (n[1] <= 0.1) { other.push(f.vertices.map(k => m.vertices[k].join(',')).sort().join(' ')); continue; }
		if (f.vertices.length == 4) quads++; else tris++;
		let ps = f.vertices.map(k => m.vertices[k]);
		for (let a of ps) for (let b of ps) { let dx = Math.abs(a[0] - b[0]), dz = Math.abs(a[2] - b[2]);
			if ((dx == 16 && dz == 0) || (dx == 0 && dz == 16)) steepest = Math.max(steepest, Math.abs(a[1] - b[1])); } }
	return JSON.stringify({at, quads, tris, steepest, other}); })()`;

// Ground of 8 x 8 half tiles, x 96..224, z 96..224, sharing corners, with a wall tile standing on its x 224 edge
// at z 96..112; and a strip of 3 x 3 half tiles against the cluster border at x 0
await ev(`(() => {
	newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove());
	let floor = (name, x0, z0, n) => { let m = new Mesh({name, vertices: {}}); let map = {};
		let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
		for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { let x = x0 + i * 16, z = z0 + j * 16;
			let f = new MeshFace(m, {vertices: [[x,0,z],[x+16,0,z],[x+16,0,z+16],[x,0,z+16]].map(vert), texture: false});
			m.addFaces(f); if (f.getNormal(true)[1] < 0) f.invert(); }
		return {m, vert}; };
	let g = floor('ground', 96, 96, 8);
	let w = new MeshFace(g.m, {vertices: [[224,0,96],[224,0,112],[224,16,112],[224,16,96]].map(g.vert), texture: false});
	g.m.addFaces(w); if (w.getNormal(true)[0] < 0) w.invert();
	g.m.init();
	floor('edge', 0, 96, 3).m.init();
	unselectAllElements(); updateSelection();
	BarItems.dew_terrain.select(); DEWTileBrush.state.size = 16;
	return true; })()`);
await sleep(300);
console.log('setup:', await ev(`JSON.stringify({tool: Toolbox.selected.id, in_toolbar: Toolbars.tools.children.some(c => c.id == 'dew_terrain'), size: DEWTileBrush.state.size})`));
const hill = [[160, 160], [176, 176], [144, 160], [160, 144], [144, 144], [192, 176]];
await camera(160, 0, 160, 160, 260, 400);
console.log('start:', await ev(ground('ground', hill)));
console.log('   expect every corner 0, 64 quads, 0 triangles, steepest 0, one wall face');

await click([168, 0, 168]);
console.log('A. raise the tile at 160,160:', await ev(ground('ground', hill)));
console.log('   expect 160,160 and 176,176 at 16, the rest 0; 60 quads and 8 triangles (the four diagonal tiles split); steepest 16');

await click([168, 16, 168]);
console.log('B. raise it again:', await ev(ground('ground', hill)));
console.log('   expect 160,160 and 176,176 at 32, 144,160 and 160,144 and 192,176 at 16 (the hill spread), 144,144 at 0; steepest 16');

await click([168, 32, 168], 2);
console.log('C. ctrl lowers it:', await ev(ground('ground', hill)));
console.log('   expect 160,160 at 16, the ring still 16; steepest 16');
await ev(`Undo.undo(); true`);
console.log('D. undo:', await ev(ground('ground', [[160, 160], [144, 160]])), ' expect 160,160 at 32 and 144,160 at 16 again');

const ridge = [[112, 208], [128, 208], [160, 208], [192, 208], [112, 224], [192, 224]];
await dragWorld([104, 0, 216], [200, 0, 216]);
console.log('E. drag along the row at z 208:', await ev(ground('ground', ridge)));
console.log('   expect 16 along z 208 from x 112 on (one even ridge, never a staircase to 32 or more), and z 224 at 16 or 0; steepest 16');

const wall = [[208, 96], [224, 96], [224, 112], [208, 112]];
await click([216, 0, 104]);
console.log('F. raise the tile against the wall:', await ev(ground('ground', wall)));
console.log('   expect 224,96 and 224,112 still [0,16] (floor and wall top), 208,96 and 208,112 at 16, and the wall face unchanged');

const border = [[0, 112], [0, 128], [16, 112], [16, 128]];
await camera(24, 0, 120, 24, 200, 300);
await click([8, 0, 120]);
console.log('G. raise the tile on the cluster border:', await ev(ground('edge', border)));
console.log('   expect x 0 corners still 0, x 16 corners at 16; steepest 16');
const history = await ev(`Undo.history.length`);
await click([8, 8, 120]);
console.log('H. raise it again:', await ev(ground('edge', border)), ' undo steps added:', (await ev(`Undo.history.length`)) - history);
console.log('   expect no change and 0 undo steps: a second step would be too steep against the pinned border');

console.log('page errors:', errors.length ? errors : 'none');
ws.close();
