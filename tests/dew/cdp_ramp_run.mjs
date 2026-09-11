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
	await mouse('mouseReleased', b); await sleep(140);
}
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); return true; })()`);
	await sleep(150);
};
// Diagonal faces of the scene, as their corner positions
const diagonals = `(() => { let out = []; let r = v => Math.round(v * 100) / 100;
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey];
		let n = f.getNormal(true); if (n.filter(v => Math.abs(v) > 0.01).length < 2) continue;
		out.push(f.vertices.map(k => m.vertices[k].map(r).join(',')).sort().join(' | ') + (f.texture ? ' textured' : ' plain')); }
	return JSON.stringify(out.sort(), null, 1); })()`;
const counts = `(() => { let out = {}; for (let m of Mesh.all) out[m.name] = Object.keys(m.faces).length; return JSON.stringify(out); })()`;

// A floor patch to start a climbing run from, on the grid
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
	__build('floor', [['y', 0, 1, 0, 0, 4, 2]]);   // x 0..64, z 0..32
	unselectAllElements(); return true; })()`);
await ev(`(() => { BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(400);
await ev(`(() => { let t = Texture.all[0]; let m = Mesh.all[0];
	for (let f of Object.values(m.faces)) { let ps = f.vertices.map(k => m.vertices[k]); let x0 = Math.min(...ps.map(p => p[0])), z0 = Math.min(...ps.map(p => p[2]));
		f.texture = t.uuid; f.vertices.forEach(k => f.uv[k] = [m.vertices[k][0] - x0, m.vertices[k][2] - z0]); }
	Canvas.updateView({elements: [m], element_aspects: {faces: true, uv: true}}); return true; })()`);
await camera(32, 16, 48, 32, 90, 190);
await ev(`(() => { BarItems.dew_ramp.select(); return true; })()`);
await sleep(150);
await ev(`(() => { DEWTileBrush.state.size = 16; return true; })()`);

// Twice: a hover right after a camera move can be aimed through the previous view
await hover([24, 0, 30]);
await hover([24, 0, 30]);
console.log('A. ghost at the floor edge nearest the camera:', await ev(`!!Canvas.scene.getObjectByName('dew_tile_ghost')`), ' expect true');

// Drag from the front edge of the floor out and up: a climbing run toward the camera
await dragWorld([24, 0, 30], [24, 48, 80]);
console.log('B. climbing run:', await ev(counts));
console.log('   diagonals:', await ev(diagonals));
console.log('   expect a line of pieces stepping +16 in z and +16 in y, textured');

await ev(`Undo.undo(); true`);
console.log('C. undo:', await ev(counts), ' expect floor 8 again');

// A single piece, then extend the diagonal sideways from its vertical edge
await dragWorld([24, 0, 30], [24, 16, 46], 6);
console.log('D. one piece:', await ev(diagonals));
await camera(40, 12, 60, 120, 60, 120);
await hover([24, 8, 38]);
console.log('E. hover the diagonal:', await ev(`!!Canvas.scene.getObjectByName('dew_tile_ghost')`), ' expect true');

console.log('page errors:', errors.length ? errors : 'none');
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_ramp_run.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
