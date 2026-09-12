// Alt on the tile brush copies the plane and facing of the tile under the cursor.
// Alt on the texture brush or bucket picks up the atlas cell that tile carries.
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
// modifiers bitmask: alt 1, ctrl 2, meta 4, shift 8
async function click(world, modifiers = 0) {
	const at = await screen(...world);
	await mouse('mouseMoved', at, { button: 'none', modifiers }); await sleep(70);
	await mouse('mouseMoved', at, { button: 'none', modifiers }); await sleep(70);
	await mouse('mousePressed', at, { buttons: 1, modifiers }); await sleep(70);
	await mouse('mouseReleased', at, { modifiers }); await sleep(170);
}
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); return true; })()`);
	await sleep(170);
};
const brushState = `JSON.stringify({axis: DEWTileBrush.state.axis, depth: DEWTileBrush.state.depth, sign: DEWTileBrush.state.sign})`;
const atlasPick = `(() => { let a = DEWTileBrush.texture_state.atlas; if (!a) return 'none';
	let s = DEWTileBrush.state.size; let tex = Texture.all.find(t => t.uuid == a.texture);
	return JSON.stringify({texel: [a.x0, a.y0], cell: [Math.floor(a.x0 / s), Math.floor(a.y0 / s)], texture: tex && tex.name, selected: Texture.selected && Texture.selected.name}); })()`;
// Faces standing in the x 32 plane, as corner and facing
const wallPlane = `(() => { let out = []; let r = v => Math.round(v * 100) / 100;
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices(); if (vs.length != 4) continue;
		let n = f.getNormal(true); if (Math.abs(n[0]) < 0.99) continue;
		let ps = vs.map(k => m.vertices[k]); if (Math.abs(ps[0][0] - 32) > 0.01) continue;
		out.push(m.name + ' z' + Math.min(...ps.map(p => p[2])) + ' y' + Math.min(...ps.map(p => p[1])) + ' n' + r(n[0])); }
	return JSON.stringify(out.sort()); })()`;
const uvAt = (x, z) => `(() => { for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices();
		if (vs.length != 4) continue; let n = f.getNormal(true); if (n[1] < 0.99) continue;
		let ps = vs.map(k => m.vertices[k]);
		if (Math.min(...ps.map(p => p[0])) != ${x} || Math.min(...ps.map(p => p[2])) != ${z}) continue;
		let uvs = vs.map(k => f.uv[k]).filter(uv => uv);
		return JSON.stringify({textured: !!f.texture, uv_min: uvs.length ? [Math.min(...uvs.map(u => u[0])), Math.min(...uvs.map(u => u[1]))] : null}); }
	return 'no tile'; })()`;

// Ground facing up, and a wall at x 32 that faces -x, so its facing can differ from the camera side later
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
	__build('wall', [['x', 32, -1, 0, 0, 4, 2]]);
	unselectAllElements(); return true; })()`);
await ev(`(() => { BarItems.dew_tile_brush.select(); let s = DEWTileBrush.state; s.size = 16; s.axis = 'y'; s.depth = 0; s.sign = null; return true; })()`);
await sleep(200);

// Seen from -x, the side the wall faces, so it is drawn and can be hit
await camera(32, 16, 24, -120, 60, 40);
console.log('start:', await ev(brushState), ' expect axis y, depth 0, sign null');
await click([32, 8, 24], 1);
console.log('A. alt click on the wall:', await ev(brushState), ' expect axis x, depth 32, sign -1');

// From the other side the camera alone would say +1
await camera(32, 16, 24, 170, 60, 40);
console.log('B. camera moved to +x:', await ev(brushState), ' expect sign still -1');
await click([32, 40, 24]);
console.log('C. paint above the wall:', await ev(wallPlane));
console.log('   expect a new tile at z16 y32 with normal -1, the facing that was picked up, not the camera side');

await ev(`Undo.undo(); true`);
await ev(`(() => { BarItems.dew_tile_plane_axis.click(); return true; })()`);
console.log('D. W turns the plane:', await ev(brushState), ' expect sign null, following the camera again');

// The atlas eyedropper
await ev(`(() => { BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(500);
await ev(`(() => { let t = Texture.all[0]; let m = Mesh.all.find(m => m.name == 'ground');
	let put = (x, z, u, v) => { for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices();
		let ps = vs.map(k => m.vertices[k]);
		if (Math.min(...ps.map(p => p[0])) != x || Math.min(...ps.map(p => p[2])) != z) continue;
		f.texture = t.uuid;
		vs.forEach(k => f.uv[k] = [u + (m.vertices[k][0] - x), v + (m.vertices[k][2] - z)]); } };
	put(0, 0, 0, 0);      // cell 0,0
	put(16, 0, 48, 0);    // cell 3,0 at size 16
	Canvas.updateView({elements: [m], element_aspects: {faces: true, uv: true}}); return true; })()`);
await ev(`(() => { BarItems.dew_texture_brush.select(); DEWTileBrush.state.size = 16; DEWTileBrush.texture_state.atlas = null; return true; })()`);
await sleep(250);
await camera(32, 0, 32, 40, 150, 110);
console.log('E. nothing picked yet:', await ev(atlasPick), ' expect none');
await click([24, 0, 8], 1);
console.log('F. alt click the tile carrying cell 3,0:', await ev(atlasPick), ' expect texel [48,0], cell [3,0], the atlas selected');

await click([40, 0, 8]);
console.log('G. painting an untextured tile uses it:', await ev(uvAt(32, 0)), ' expect textured true, uv_min [48,0]');

await ev(`(() => { BarItems.dew_paint_bucket.select(); return true; })()`);
await sleep(200);
await click([8, 0, 8], 1);
console.log('H. alt click under the bucket, on the tile with cell 0,0:', await ev(atlasPick), ' expect texel [0,0], cell [0,0]');

await click([8, 40, 8], 1);
console.log('I. alt click on empty space:', await ev(atlasPick), ' expect unchanged, cell [0,0]');

console.log('page errors:', errors.length ? errors : 'none');
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_eyedropper.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
