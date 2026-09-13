// Probe: the terrain brush on a copy of the user's Warehouse scene. Pass the .bbmodel path as PROBE_FILE.
const FILE = process.env.PROBE_FILE;
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type == 'page' && t.url.includes('index.html')) ?? targets.find(t => t.type == 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => { const m = JSON.parse(e.data);
	if (m.method == 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
	if (m.method == 'Runtime.consoleAPICalled' && m.params.type == 'error') errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
	if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result.result.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { if (await ev('typeof Blockbench != "undefined" && !!window.Preview && Preview.all.length > 0')) break; await sleep(500); }
await send('Runtime.enable');

const screen = async (x, y, z) => JSON.parse(await ev(`(() => { let p = Preview.selected; let v = new THREE.Vector3(${x}, ${y}, ${z}).project(p.camera); let r = p.canvas.getBoundingClientRect(); return JSON.stringify([r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]); })()`));
const mouse = (type, [x, y], extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
async function click(world) {
	const at = await screen(...world);
	for (let i = 0; i < 2; i++) { await mouse('mouseMoved', at, { button: 'none' }); await sleep(90); }
	await mouse('mousePressed', at, { buttons: 1 }); await sleep(70);
	await mouse('mouseReleased', at, {}); await sleep(300);
}
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); if (p.render) p.render(); return true; })()`);
	await sleep(250);
};

await ev(`new Promise(done => Blockbench.read([${JSON.stringify(FILE)}], {readtype: 'text'}, files => { loadModelFile(files[0]); done(true); }))`);
for (let i = 0; i < 20; i++) { if (await ev(`Mesh.all.some(m => m.name == 'floor')`)) break; await sleep(300); }
await sleep(500);
console.log('loaded:', await ev(`JSON.stringify({format: Format.id, meshes: Mesh.all.map(m => m.name)})`));

// Face centres in world space, and which of them fall inside the 0..320 cluster
const faces = await ev(`(() => { let out = {};
	for (let m of Mesh.all) { m.mesh.updateMatrixWorld(true); let list = [];
		for (let fkey in m.faces) { let f = m.faces[fkey]; if (f.getNormal(true)[1] <= 0.1) continue;
			let c = new THREE.Vector3(); f.vertices.forEach(k => c.add(new THREE.Vector3().fromArray(m.vertices[k]))); c.divideScalar(f.vertices.length); m.mesh.localToWorld(c);
			list.push({fkey, c: [c.x, c.y, c.z].map(v => Math.round(v * 100) / 100)}); }
		let xs = list.map(e => e.c[0]), zs = list.map(e => e.c[2]);
		out[m.name] = {count: list.length, x: [Math.min(...xs), Math.max(...xs)], z: [Math.min(...zs), Math.max(...zs)],
			inside: list.find(e => e.c[0] > 64 && e.c[0] < 256 && e.c[2] > 64 && e.c[2] < 256) || null,
			outside: list.find(e => e.c[0] > 330 || e.c[0] < -10 || e.c[2] > 330 || e.c[2] < -10) || null,
			first: list[0] || null}; }
	return JSON.stringify(out); })()`);
console.log('up faces per mesh:', faces);
const info = JSON.parse(faces);

const ground = (name, fkey) => `(() => { let m = Mesh.all.find(m => m.name == '${name}'); let g = DEWTileBrush.buildGround(m, '${fkey}');
	let f = m.faces['${fkey}']; let corners = f.vertices;
	let settle = DEWTileBrush.settleTerrain(g, corners, Math.max(...corners.map(g.height)) + 16, 1);
	return JSON.stringify({ground: g.ground.size, grid: g.grid.size, pinned: g.pinned.size, corners_pinned: corners.filter(k => g.pinned.has(k)).length, settle: settle ? settle.size : null}); })()`;
for (const [name, where] of [['floor', 'inside'], ['floor', 'outside'], ['walls', 'first']]) {
	const entry = info[name] && info[name][where];
	if (!entry) { console.log(name, where, ': no such face'); continue; }
	console.log(`${name} ${where} ${entry.c}:`, await ev(ground(name, entry.fkey)));
}

// The real tool on a block top and on a floor tile inside the cluster
await ev(`(() => { BarItems.dew_terrain.select(); DEWTileBrush.state.size = 16; return true; })()`);
for (const [name, where] of [['walls', 'first'], ['floor', 'inside'], ['floor', 'outside']]) {
	const entry = info[name] && info[name][where];
	if (!entry) continue;
	const [x, y, z] = entry.c;
	await camera(x, y, z, x, y + 140, z + 90);
	const before = errors.length, undo = await ev(`Undo.history.length`);
	await click([x, y, z]);
	console.log(`click ${name} ${where}:`, JSON.stringify({undo_steps: (await ev(`Undo.history.length`)) - undo, new_errors: errors.slice(before)}));
}
console.log('all errors:', errors.length ? errors : 'none');
ws.close();
