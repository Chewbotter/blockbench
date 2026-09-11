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
const CTRL = 2;
async function jitterClick(world) {
	const [x, y] = await screen(...world);
	await mouse('mouseMoved', [x, y], { button: 'none', modifiers: CTRL }); await sleep(40);
	await mouse('mousePressed', [x, y], { modifiers: CTRL, buttons: 1 }); await sleep(40);
	for (const d of [1, 2, 1]) { await mouse('mouseMoved', [x + d, y], { modifiers: CTRL, buttons: 1 }); await sleep(40); }
	await mouse('mouseReleased', [x + 1, y], { modifiers: CTRL }); await sleep(80);
}
async function drag(from, to, steps = 16) {
	const a = await screen(...from), b = await screen(...to);
	await mouse('mouseMoved', a, { button: 'none', modifiers: CTRL }); await sleep(30);
	await mouse('mousePressed', a, { modifiers: CTRL, buttons: 1 }); await sleep(30);
	for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps], { modifiers: CTRL, buttons: 1 }); await sleep(25); }
	await mouse('mouseReleased', b, { modifiers: CTRL }); await sleep(80);
}

// A 32-unit cube, each side 2x2 half-tile quads facing outward; camera sees the +x, +y and +z sides
const build = `(() => {
	newProject(Formats.dew_scene);
	let m = new Mesh({name: 'box', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	let axes = {x: ['z', 'y'], y: ['x', 'z'], z: ['x', 'y']};
	for (let axis of ['x', 'y', 'z']) for (let depth of [0, 32]) for (let u = 0; u < 32; u += 16) for (let v = 0; v < 32; v += 16) {
		let [ua, va] = axes[axis];
		let pt = (du, dv) => { let p = {}; p[axis] = depth; p[ua] = u + du; p[va] = v + dv; return [p.x, p.y, p.z]; };
		let f = new MeshFace(m, {vertices: [pt(0,0), pt(16,0), pt(16,16), pt(0,16)].map(vert), texture: false});
		m.addFaces(f);
		let n = f.getNormal(true); let i = {x: 0, y: 1, z: 2}[axis];
		if ((n[i] > 0) != (depth > 0)) f.invert();
	}
	m.init(); unselectAllElements();
	let p = Preview.selected; p.controls.target.set(16, 16, 16); p.camera.position.set(16 + 70, 16 + 55, 16 + 95); p.controls.update();
	BarItems.dew_tile_brush.select(); DEWTileBrush.state.size = 16;
	return true; })()`;
const count = `(() => { let m = Mesh.all.find(m => m.name == 'box'); let faces = Object.values(m.faces);
	let sides = {}; faces.forEach(f => { let n = f.getNormal(true).map(v => Math.round(v)).join(','); sides[n] = (sides[n] || 0) + 1; });
	return JSON.stringify({faces: faces.length, per_side: sides}); })()`;

await ev(build);
console.log('start:', await ev(count));
await jitterClick([8, 8, 32]);
console.log('A. ctrl+click with 1px jitter on one +z plane:', await ev(count), ' expect 23, only 0,0,1 down to 3');

await ev(build);
await drag([8, 8, 32], [24, 8, 32]);
console.log('B. ctrl+drag across two +z planes:', await ev(count), ' expect 22, only 0,0,1 down to 2');

await ev(build);
await drag([24, 8, 32], [32, 8, 24]);
console.log('C. ctrl+drag from +z onto +x:', await ev(count), ' expect 22, one from 0,0,1 and one from 1,0,0');

console.log('page errors:', errors.length ? errors : 'none');
ws.close();
