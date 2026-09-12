// A ramp with the floor carrying on underneath it, then wall tiles painted beside it.
// The gap at the ramp's foot sits on a floor edge shared by two floor tiles, which must not stop it closing.
// Holes are counted as three-edge loops that no face fills or covers, the same coplanar point-in-polygon rule
// the capper uses, so a gap closed by a full square tile does not count as open.
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

// Three-edge loops over ALL edges, not just boundary ones, so a gap standing on continuous floor still shows up
const holes = `(() => { let r = v => Math.round(v * 100) / 100; let key = p => p.map(r).join(',');
	let faces = [];
	for (let m of Mesh.all) { if (m.visibility === false || m.export === false) continue;
		for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices(); if (vs.length < 3) continue;
			faces.push({name: m.name, n: f.getNormal(true).map(r).join(','), pts: vs.map(k => m.vertices[k].slice()), keys: vs.map(k => key(m.vertices[k]))}); } }
	let edges = new Map();
	for (let f of faces) f.keys.forEach((a, i) => { let b = f.keys[(i + 1) % f.keys.length];
		let [lo, hi] = [a, b].slice().sort(); let eid = lo + '>' + hi;
		let e = edges.get(eid) || {a: lo, b: hi, faces: []}; e.faces.push(f.name + ' n' + f.n); edges.set(eid, e); });
	let sub = (p, q) => [0,1,2].map(i => p[i] - q[i]);
	let cross = (u, v) => [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
	let dot = (u, v) => u[0]*v[0] + u[1]*v[1] + u[2]*v[2];
	let coveredBy = tri => {                                     // the faceCovers rule, replicated
		let n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])); let len = Math.hypot(...n); n = n.map(v => v / len);
		let centre = [0,1,2].map(i => (tri[0][i] + tri[1][i] + tri[2][i]) / 3);
		let dominant = [0,1,2].reduce((best, i) => Math.abs(n[i]) > Math.abs(n[best]) ? i : best, 0);
		let [across, down] = [0,1,2].filter(i => i != dominant);
		for (let f of faces) {
			if (f.pts.some(p => Math.abs(dot(sub(p, tri[0]), n)) > 1e-3)) continue;
			let inside = false;
			for (let i = 0, j = f.pts.length - 1; i < f.pts.length; j = i++) {
				let a = f.pts[i], b = f.pts[j];
				if ((a[down] > centre[down]) == (b[down] > centre[down])) continue;
				let crossing = a[across] + (centre[down] - a[down]) / (b[down] - a[down]) * (b[across] - a[across]);
				if (centre[across] < crossing) inside = !inside; }
			if (inside) return f.name + ' n' + f.n; }
		return null; };
	let byPoint = new Map();
	for (let e of edges.values()) for (let p of [e.a, e.b]) byPoint.set(p, (byPoint.get(p) || []).concat([e]));
	let diagonal = e => { let p = [e.a, e.b].map(s => s.split(',').map(Number));
		return [0,1,2].map(i => Math.abs(p[1][i] - p[0][i])).filter(d => d > 0.01).length > 1; };
	let seen = new Set(); let out = [];
	for (let e of edges.values()) { let [a, b] = [e.a, e.b];
		for (let e2 of byPoint.get(b) || []) { if (e2 === e) continue; let c = e2.a === b ? e2.b : e2.a; if (c === a) continue;
			let e3 = (byPoint.get(c) || []).find(o => o !== e2 && (o.a === a || o.b === a)); if (!e3) continue;
			let tri = [a, b, c].slice().sort(); let tid = tri.join('|'); if (seen.has(tid)) continue; seen.add(tid);
			let p = tri.map(s => s.split(',').map(Number));
			if (Math.hypot(...cross(sub(p[1], p[0]), sub(p[2], p[0]))) < 0.001) continue;   // collinear, a T junction
			if (![e, e2, e3].some(diagonal)) continue;                                      // only ramp related gaps
			let filled = faces.some(f => f.keys.length == 3 && f.keys.slice().sort().join('|') == tid);
			if (filled || coveredBy(p)) continue;
			out.push({tri: tri.join(' | '), edges: [e, e2, e3].map(x => (diagonal(x) ? 'diag ' : 'axis ') + x.faces.length + ' [' + x.faces.join(' + ') + ']')}); } }
	return JSON.stringify(out, null, 1); })()`;
const triangles = `(() => { let r = v => Math.round(v * 100) / 100; let out = [];
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices();
		if (vs.length != 3) continue;
		out.push(m.name + ': ' + vs.map(k => m.vertices[k].map(r).join(',')).sort().join(' | ') + (f.texture ? ' textured' : ' PLAIN')); }
	return JSON.stringify(out.sort(), null, 1); })()`;
const wallTiles = `(() => { let out = [];
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices();
		if (vs.length != 4) continue; let n = f.getNormal(true); if (Math.abs(n[0]) < 0.99) continue;
		out.push('x ' + m.vertices[vs[0]][0]); }
	return JSON.stringify(out.sort()); })()`;

// Floor over the whole area, so it carries on underneath the ramp
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
	__build('floor', [['y', 0, 1, 0, 0, 4, 6]]);   // x 0..64, z 0..96: under the ramp too
	unselectAllElements(); return true; })()`);
await ev(`(() => { BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(400);
await ev(`(() => { let t = Texture.all[0];
	for (let m of Mesh.all) for (let f of Object.values(m.faces)) { f.texture = t.uuid; f.vertices.forEach(k => f.uv[k] = [0, 0]); }
	return true; })()`);
await camera(32, 20, 48, 150, 80, 150);
await ev(`(() => { BarItems.dew_ramp.select(); DEWTileBrush.state.size = 16; return true; })()`);
await sleep(150);

// A ramp rising over the floor, in x 16..32, climbing from z 32 to z 80
await hover([24, 0, 30]);
await hover([24, 0, 30]);
await dragWorld([24, 0, 30], [24, 48, 78]);
console.log('A. ramp over a continuous floor:', await ev(`(() => { let n = 0; for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; if (f.getSortedVertices().length == 4 && f.getNormal(true).filter(v => Math.abs(v) > 0.01).length > 1) n++; } return n; })()`), ' expect 3 diagonals');
console.log('B. holes before any wall:', await ev(holes), ' expect none: nothing closes a loop yet');

// Looking straight down -x, so a click below the slope hits nothing and the brush falls back to the work plane x 32
await camera(32, 20, 56, 220, 20, 56);
await ev(`(() => { BarItems.dew_tile_brush.select(); let s = DEWTileBrush.state; s.size = 16; s.axis = 'x'; s.depth = 32; return true; })()`);
await sleep(150);
for (let point of [[32, 8, 56], [32, 8, 72], [32, 24, 72]]) {
	await hover(point);
	await hover(point);
	await dragWorld(point, point, 1);
}
console.log('C. wall tiles painted at:', await ev(wallTiles), ' expect every one at x 32');
console.log('D. holes after painting:', await ev(holes));
console.log('   expect none: the gap at the ramp foot closes even though its bottom edge is shared by two floor tiles');
console.log('E. triangles:', await ev(triangles));
console.log('   expect 2 caps in the x 32 plane, including 32,0,32 | 32,0,48 | 32,16,48 at the foot');

await ev(`Undo.undo(); true`);
console.log('F. undo takes the last cap with it:', await ev(triangles), ' expect 1 cap left');

console.log('page errors:', errors.length ? errors : 'none');
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_ramp_floor.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
