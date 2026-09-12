// Painting a drag across a big mesh must not rebuild the whole mesh once per tile, and hovering must not
// rescan every face in the scene on every mouse move.
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
async function dragWorld(from, to, steps) {
	const a = await screen(...from), b = await screen(...to);
	await mouse('mouseMoved', a, { button: 'none' }); await sleep(60);
	await mouse('mousePressed', a, { buttons: 1 }); await sleep(60);
	for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps], { buttons: 1 }); await sleep(25); }
	await mouse('mouseReleased', b); await sleep(220);
}
const hoverBench = async (world, times) => {
	const at = await screen(...world);
	return ev(`(() => { let p = Preview.selected; let t0 = performance.now();
		for (let i = 0; i < ${times}; i++) {
			p.canvas.dispatchEvent(new MouseEvent('mousemove', {clientX: ${at[0]} + (i % 3), clientY: ${at[1]} + (i % 2), bubbles: true}));
		}
		return Math.round((performance.now() - t0) / ${times} * 100) / 100; })()`);
};

// A 60 x 60 floor, 3600 tiles, and a wall standing across it so a hover has a face to pick a side against
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
	__build('ground', [['y', 0, 1, 0, 0, 60, 60]]);
	__build('wall', [['x', 480, 1, 0, 0, 20, 2]]);
	unselectAllElements(); updateSelection();
	let p = Preview.selected; p.controls.target.set(480, 0, 300); p.camera.position.set(900, 400, 900); p.controls.update();
	// Count only the rebuilds, which are the expensive ones
	window.__stats = {rebuilds: 0, ms: 0};
	let original = Canvas.updateView.bind(Canvas);
	Canvas.updateView = function(options) { let t0 = performance.now(); let out = original(options);
		if (options && options.element_aspects && options.element_aspects.geometry) { __stats.rebuilds++; __stats.ms += performance.now() - t0; }
		return out; };
	// Tiles standing in the plane the drag paints on
	window.__painted = () => { let n = 0;
		for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices();
			if (vs.length == 4 && Math.abs(m.vertices[vs[0]][1] - 16) < 0.01 && Math.abs(f.getNormal(true)[1]) > 0.99) n++; }
		return n; };
	return Object.keys(Mesh.all[0].faces).length; })()`);
await sleep(800);
console.log('ground faces:', await ev(`Object.keys(Mesh.all.find(m => m.name == 'ground').faces).length`), ' expect 3600');

await ev(`(() => { BarItems.dew_tile_brush.select(); let s = DEWTileBrush.state; s.size = 16; s.axis = 'y'; s.depth = 16; s.sign = null;
	Mesh.all.find(m => m.name == 'ground').select(); return true; })()`);
await sleep(400);
await ev(`window.__stats = {rebuilds: 0, ms: 0}`);
// Paint a run of new tiles one level up, so every step adds geometry
await dragWorld([-200, 16, 160], [-200, 16, 620], 24);
console.log('A. drag painting a row:', await ev(`JSON.stringify({tiles_painted: __painted(), rebuilds: __stats.rebuilds, rebuild_ms: Math.round(__stats.ms)})`));
console.log('   expect far more tiles than rebuilds: a frame that crosses several tiles rebuilds once,');
console.log('   and every rebuild here redraws the whole 3600 tile mesh, which is what used to run per tile');

await ev(`window.__stats = {rebuilds: 0, ms: 0}`);
const wall_at = JSON.parse(await ev(`(() => { let p = Preview.selected; let r = p.canvas.getBoundingClientRect();
	for (let y = 8; y <= 24; y += 8) for (let z = 80; z < 560; z += 20) {
		let v = new THREE.Vector3(480, y, z).project(p.camera);
		let e = {clientX: r.left + (v.x + 1) / 2 * r.width, clientY: r.top + (1 - v.y) / 2 * r.height, target: p.canvas};
		if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
		let hit = DEWTileBrush.hitFace(p, e);
		if (hit && hit.element.name == 'wall') return JSON.stringify([e.clientX, e.clientY]);
	}
	return 'null'; })()`));
if (!wall_at) throw new Error('no point on the wall was visible, the hover measurement needs one');
const hoverRun = drop_cache => `(() => { let p = Preview.selected; let t0 = performance.now();
	for (let i = 0; i < 40; i++) {
		${drop_cache ? "Blockbench.dispatchEvent('finished_edit', {});" : ''}
		p.canvas.dispatchEvent(new MouseEvent('mousemove', {clientX: ${wall_at[0]} + (i % 3), clientY: ${wall_at[1]} + (i % 2), bubbles: true}));
	}
	return Math.round((performance.now() - t0) / 40 * 100) / 100; })()`;
console.log('B. hover over the wall, where the brush has to choose a side of the edge:');
console.log('   scan cached:', await ev(hoverRun(false)), 'ms per move, rebuilds', await ev(`__stats.rebuilds`));
console.log('   scan dropped before every move:', await ev(hoverRun(true)), 'ms per move  (what every move cost before)');
console.log('   the cursor is over:', await ev(`(() => { let p = Preview.selected;
	let hit = DEWTileBrush.hitFace(p, {clientX: ${wall_at[0]}, clientY: ${wall_at[1]}, target: p.canvas});
	return JSON.stringify({mesh: hit && hit.element.name, normal: hit && hit.normal.toArray().map(v => Math.round(v))}); })()`), ' expect the wall, normal 1,0,0');

console.log('C. undo takes the row away again:', await ev(`(() => { Undo.undo(); return __painted(); })()`), ' expect 0');
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
