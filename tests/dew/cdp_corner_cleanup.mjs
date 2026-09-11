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
async function click(world) {
	const at = await screen(...world);
	await mouse('mouseMoved', at, { button: 'none' }); await sleep(50);
	await mouse('mousePressed', at, { buttons: 1 }); await sleep(50);
	await mouse('mouseReleased', at); await sleep(140);
}
async function key(letter) {
	const code = letter.toUpperCase().charCodeAt(0);
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await sleep(90);
}
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); return true; })()`);
	await sleep(150);
};
// Corner triangles standing in a plane x = value, by leg length, plus any duplicated or open geometry
const atPlane = value => `(() => { let out = [];
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; if (f.vertices.length != 3) continue;
		let ps = f.vertices.map(k => m.vertices[k]); if (!ps.every(p => Math.abs(p[0] - ${value}) < 0.001)) continue;
		out.push(ps.map(p => p.join(',')).sort().join(' / ')); }
	return JSON.stringify(out.sort()); })()`;
const health = `(() => {
	let loops = 0, duplicates = 0, untextured = 0, caps = 0;
	for (let m of Mesh.all) {
		let edges = new Map(), seen = new Set();
		for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices(); if (vs.length < 3) continue;
			let id = vs.slice().sort().join('|'); if (seen.has(id)) duplicates++; seen.add(id);
			if (vs.length == 3) { caps++; if (!f.texture) untextured++; }
			vs.forEach((v, i) => { let key = [v, vs[(i + 1) % vs.length]].sort().join('|');
				edges.set(key, (edges.get(key) || 0) + 1); }); }
		let open = [...edges.keys()].filter(k => edges.get(k) == 1).map(k => k.split('|'));
		let by = new Map(); for (let [a, b] of open) { by.set(a, (by.get(a) || []).concat([b])); by.set(b, (by.get(b) || []).concat([a])); }
		let counted = new Set();
		for (let [a, b] of open) for (let c of by.get(b) || []) { if (c == a) continue;
			if (!(by.get(c) || []).includes(a)) continue; let id = [a, b, c].sort().join('|'); if (counted.has(id)) continue; counted.add(id);
			let p = [a, b, c].map(k => m.vertices[k]);
			let ab = [0, 1, 2].map(i => p[1][i] - p[0][i]), ac = [0, 1, 2].map(i => p[2][i] - p[0][i]);
			let cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
			if (Math.hypot(...cross) < 0.001) continue;   // collinear: a T-junction, not a hole
			loops++; }
	}
	return JSON.stringify({triangular_holes: loops, duplicate_faces: duplicates, triangles: caps, untextured_triangles: untextured}); })()`;

// A room: floor x 0..128 z 0..64, wall_z at z 0, wall_x at x 0, both 32 tall, all textured
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
	__build('room', [['y', 0, 1, 0, 0, 8, 4], ['z', 0, 1, 0, 0, 8, 2], ['x', 0, 1, 0, 0, 4, 2]]);
	unselectAllElements(); return true; })()`);
await ev(`(() => { BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(400);
await ev(`(() => { let t = Texture.all[0]; let m = Mesh.all[0];
	for (let f of Object.values(m.faces)) { let ps = f.vertices.map(k => m.vertices[k]);
		let mins = [0, 1, 2].map(i => Math.min(...ps.map(p => p[i])));
		f.texture = t.uuid; f.vertices.forEach(k => { let p = m.vertices[k]; f.uv[k] = [(p[0] - mins[0]) + (p[2] - mins[2]), (p[1] - mins[1]) + (p[2] - mins[2])]; }); }
	Canvas.updateView({elements: [m], element_aspects: {faces: true, uv: true}}); return true; })()`);
await camera(64, 8, 24, 64 + 60, 8 + 120, 24 + 150);
await ev(`(() => { BarItems.dew_ramp.select(); return true; })()`);
await sleep(150);
console.log('start:', await ev(health), ' expect no holes, no duplicates');

await click([48, 0, 8]);
console.log('A. full-size ramp x 32..64:', await ev(health));
console.log('   triangles at x=32:', await ev(atPlane(32)), ' at x=64:', await ev(atPlane(64)), ' expect one 32x32 at each');

await key('c');
await click([72, 0, 4]);
console.log('B. half ramp x 64..80 beside it:', await ev(atPlane(64)), ' expect only the 32x32, the small one skipped');
console.log('   ', await ev(health), ' expect no duplicates');

await click([88, 0, 4]);
console.log('C. half ramp x 80..96:', await ev(atPlane(80)), ' expect none: equal sizes cancel');

await key('c');
await click([112, 0, 8]);
console.log('D. full ramp x 96..128 beside the half one:', await ev(atPlane(96)), ' expect one 32x32, the small one removed');
console.log('   ', await ev(health));

await key('c');
await click([8, 0, 4]);
await click([4, 0, 24]);
console.log('E. two half ramps meeting at the room corner:', await ev(health), ' expect triangular_holes 0, untextured_triangles 0');

// A free-standing block with a convex corner on an open floor, for ramp meeting chamfer
await ev(`(() => { __build('block', [['y', 0, 1, 192, 0, 6, 6], ['z', 32, 1, 192, 0, 2, 2], ['x', 224, 1, 0, 0, 2, 2]]);
	let t = Texture.all[0]; let m = Mesh.all.find(m => m.name == 'block');
	for (let f of Object.values(m.faces)) { let ps = f.vertices.map(k => m.vertices[k]); let mins = [0, 1, 2].map(i => Math.min(...ps.map(p => p[i])));
		f.texture = t.uuid; f.vertices.forEach(k => { let p = m.vertices[k]; f.uv[k] = [(p[0] - mins[0]) + (p[2] - mins[2]), (p[1] - mins[1]) + (p[2] - mins[2])]; }); }
	Canvas.updateView({elements: [m], element_aspects: {faces: true, uv: true}}); unselectAllElements(); return true; })()`);
await camera(224, 12, 32, 224 + 90, 12 + 80, 32 + 120);
// What the corner tools see at a world point
const look = async (x, y, z) => ev(`(() => { let p = Preview.selected; let v = new THREE.Vector3(${x}, ${y}, ${z}).project(p.camera); let r = p.canvas.getBoundingClientRect();
	let e = {clientX: r.left + (v.x + 1) / 2 * r.width, clientY: r.top + (1 - v.y) / 2 * r.height, target: p.canvas};
	let hit = DEWTileBrush.hitFace(p, e);
	let tile = hit && DEWTileBrush.describeTile(hit.element, hit.element.faces[hit.face]);
	let tiles = DEWTileBrush.buildTileIndex();
	let show = t => t && (t.n + ' ' + t.e + ' side ' + t.s2 + ' along ' + t.al + ' ' + t.lo + '..' + t.hi);
	return JSON.stringify({on_canvas: e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom,
		size: DEWTileBrush.state.size, mesh: hit && hit.element.name, tile: tile && [tile.axis, tile.depth, tile.sign, tile.u, tile.v].join(' '),
		ramp: show(DEWTileBrush.shaveTarget(p, e, tiles, true)), shave: show(DEWTileBrush.shaveTarget(p, e, tiles, false))}); })()`);
console.log('   at the ramp point:', await look(216, 0, 36));
console.log('   at the shave point:', await look(222, 20, 32));
console.log('   index around the block:', await ev(`(() => { let tiles = DEWTileBrush.buildTileIndex();
	let planes = {}; for (let key of tiles.keys()) { let [axis, depth, sign] = key.split('|'); let p = axis + ' ' + depth + ' ' + sign; planes[p] = (planes[p] || 0) + 1; }
	return JSON.stringify({wanted: ['y|0|1|208|32', 'z|32|1|208|0', 'x|224|1|16|16'].map(k => k + (tiles.has(k) ? ' yes' : ' NO')), planes}); })()`));
await click([216, 0, 36]);
console.log('F. ramp along the block base at x 208..224:', await ev(health));
await ev(`(() => { BarItems.dew_shave.select(); return true; })()`);
await sleep(150);
await click([222, 20, 32]);
console.log('   then shave the block corner above it:', await ev(health), ' expect triangular_holes 0, untextured_triangles 0');
console.log('   triangles around the junction:', await ev(`(() => { let m = Mesh.all.find(m => m.name == 'block'); let out = [];
	for (let fkey in m.faces) { let f = m.faces[fkey]; if (f.vertices.length != 3) continue;
		out.push(f.vertices.map(k => m.vertices[k].join(',')).sort().join(' / ') + (f.texture ? '' : ' UNTEXTURED')); }
	return JSON.stringify(out.sort()); })()`));

await camera(224, 12, 32, 224 + 70, 12 + 60, 32 + 90);
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_corner_cleanup.png', Buffer.from(shot.result.data, 'base64'));
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
