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
async function dragWorld(from, to, steps = 12) {
	const a = await screen(...from), b = await screen(...to);
	await mouse('mouseMoved', a, { button: 'none' }); await sleep(50);
	await mouse('mousePressed', a, { buttons: 1 }); await sleep(50);
	for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps], { buttons: 1 }); await sleep(25); }
	await mouse('mouseReleased', b); await sleep(160);
}
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); return true; })()`);
	await sleep(150);
};
const shapes = `(() => { let r = v => Math.round(v * 100) / 100; let out = {triangles: [], diagonals: 0, open_triangular_holes: 0};
	let edges = new Map();
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices(); if (vs.length < 3) continue;
		let n = f.getNormal(true);
		if (vs.length == 3) out.triangles.push(m.name + ': ' + vs.map(k => m.vertices[k].map(r).join(',')).sort().join(' | ') + (f.texture ? ' textured' : ' PLAIN'));
		if (vs.length == 4 && n.filter(v => Math.abs(v) > 0.01).length > 1) out.diagonals++;
		vs.forEach((k, i) => { let a = m.vertices[k].map(r).join(','), b = m.vertices[vs[(i + 1) % vs.length]].map(r).join(',');
			let key = [a, b].sort().join('>'); edges.set(key, (edges.get(key) || 0) + 1); }); }
	let open = [...edges.keys()].filter(k => edges.get(k) == 1).map(k => k.split('>'));
	let by = new Map(); for (let [a, b] of open) { by.set(a, (by.get(a) || []).concat([b])); by.set(b, (by.get(b) || []).concat([a])); }
	let seen = new Set();
	for (let [a, b] of open) for (let c of by.get(b) || []) { if (c == a || !(by.get(c) || []).includes(a)) continue;
		let key = [a, b, c].sort().join('|'); if (seen.has(key)) continue; seen.add(key);
		let p = [a, b, c].map(s => s.split(',').map(Number));
		let ab = [0,1,2].map(i => p[1][i] - p[0][i]), ac = [0,1,2].map(i => p[2][i] - p[0][i]);
		let cross = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]];
		if (Math.hypot(...cross) > 0.001) out.open_triangular_holes++; }
	out.triangles.sort(); return JSON.stringify(out, null, 1); })()`;

// floor x 0..64 z 0..32, and a staircase wall in the plane x = 32 where the ramp will climb beside it
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
	__build('floor', [['y', 0, 1, 0, 0, 4, 2]]);
	// steps under where the slope will run: one tile at z 48..64, two at z 64..80
	__build('wall', [['x', 32, 1, 48, 0, 1, 1], ['x', 32, 1, 64, 0, 1, 2]]);
	unselectAllElements(); return true; })()`);
await ev(`(() => { BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(400);
await ev(`(() => { let t = Texture.all[0];
	for (let m of Mesh.all) for (let f of Object.values(m.faces)) { f.texture = t.uuid; f.vertices.forEach(k => f.uv[k] = [0, 0]); }
	return true; })()`);
await camera(32, 20, 48, 150, 80, 150);
await ev(`(() => { BarItems.dew_ramp.select(); DEWTileBrush.state.size = 16; return true; })()`);
await sleep(150);
console.log('start:', await ev(shapes), ' expect no triangles, no diagonals');

// Climb from the floor's far edge, one tile wide, three pieces: z 32..80 rising 0..48
await hover([24, 0, 30]);
await hover([24, 0, 30]);
await dragWorld([24, 0, 30], [24, 48, 78]);
console.log('A. ramp drawn beside the steps:', await ev(shapes));
console.log('   expect 3 diagonals, and the gaps against the steps filled with textured triangles, open_triangular_holes 0');

await ev(`Undo.undo(); true`);
console.log('B. undo takes the caps with it:', await ev(shapes), ' expect back to the start');

await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_gap_fill.png', Buffer.from(shot.result.data, 'base64'));
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
