// A full-size ramp with a half-size ramp beside it, to see exactly what stands at the junction:
// every face touching the junction plane, and every open edge anywhere in the mesh.
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
const report = `(() => { let m = Mesh.all[0]; let r = v => Math.round(v * 100) / 100;
	let at_junction = [], edges = new Map();
	for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices(); if (vs.length < 3) continue;
		let ps = vs.map(k => m.vertices[k]);
		if (ps.some(p => Math.abs(p[0] - 32) < 0.001)) at_junction.push({n: f.getNormal(true).map(r).join(','), p: ps.map(p => p.map(r).join(',')).join(' | ')});
		vs.forEach((v, i) => { let key = [v, vs[(i + 1) % vs.length]].sort().join('|'); edges.set(key, (edges.get(key) || 0) + 1); }); }
	let open = [...edges.entries()].filter(([, n]) => n == 1).map(([k]) => k.split('|').map(v => m.vertices[v].map(r).join(',')).join(' -> '));
	return JSON.stringify({faces_touching_x32: at_junction, open_edges: open.sort()}, null, 1); })()`;

await ev(`(() => {
	newProject(Formats.dew_scene);
	let m = new Mesh({name: 'tiles', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	let axes = {x: ['z', 'y'], y: ['x', 'z'], z: ['x', 'y']};
	for (let [axis, depth, sign, u0, v0, nu, nv] of [['y', 0, 1, 0, 0, 6, 4], ['z', 0, 1, 0, 0, 6, 2]]) { let [ua, va] = axes[axis];
		for (let u = u0; u < u0 + nu * 16; u += 16) for (let v = v0; v < v0 + nv * 16; v += 16) {
			let pt = (du, dv) => { let p = {}; p[axis] = depth; p[ua] = u + du; p[va] = v + dv; return [p.x, p.y, p.z]; };
			let f = new MeshFace(m, {vertices: [pt(0,0), pt(16,0), pt(16,16), pt(0,16)].map(vert), texture: false});
			m.addFaces(f); if (f.getNormal(true)[{x: 0, y: 1, z: 2}[axis]] * sign < 0) f.invert(); } }
	m.init(); unselectAllElements(); return true; })()`);
await camera(48, 8, 24, 48 + 80, 8 + 90, 24 + 130);
await ev(`(() => { BarItems.dew_ramp.select(); return true; })()`);
await sleep(150);
await click([16, 0, 8]);          // full size (the default): ramps x 0..32
await key('c');
await click([40, 0, 4]);          // half size: ramps x 32..48
console.log(await ev(report));
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
