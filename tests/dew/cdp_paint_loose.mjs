// Ramps and cap triangles take atlas cells like any tile, stretched across the face.
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
const hover = async world => { await mouse('mouseMoved', await screen(...world), { button: 'none' }); await sleep(90); };
async function click(world) {
	const at = await screen(...world);
	await mouse('mouseMoved', at, { button: 'none' }); await sleep(60);
	await mouse('mousePressed', at, { buttons: 1 }); await sleep(60);
	await mouse('mouseReleased', at); await sleep(200);
}
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); return true; })()`);
	await sleep(170);
};
// The slanted and three-cornered faces, with the uv each corner carries
const loose = `(() => { let r = v => Math.round(v * 100) / 100; let out = [];
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices();
		let n = f.getNormal(true);
		let slanted = vs.length == 4 && n.filter(v => Math.abs(v) > 0.01).length > 1;
		if (!slanted && vs.length != 3) continue;
		out.push({kind: vs.length == 3 ? 'triangle' : 'ramp', textured: !!f.texture,
			corners: vs.map(k => m.vertices[k].map(r).join(',') + ' uv ' + (f.uv[k] || []).map(r).join(',')).sort()}); }
	return JSON.stringify(out.sort((a, b) => a.kind.localeCompare(b.kind) || a.corners[0].localeCompare(b.corners[0])), null, 1); })()`;

// The room from the ramp test: a corner ramp leaves a slope and two cap triangles
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
	__build('floor', [['y', 0, 1, 0, 0, 4, 4]]);
	__build('wall_z', [['z', 0, 1, 0, 0, 4, 3]]);
	unselectAllElements(); return true; })()`);
await ev(`(() => { BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(500);
await camera(32, 16, 32, 152, 106, 182);
await ev(`(() => { BarItems.dew_ramp.select(); DEWTileBrush.state.size = 16; return true; })()`);
await sleep(200);
await hover([24, 0, 6]);
await hover([24, 0, 6]);
await click([24, 0, 6]);
console.log('A. the corner ramp:', await ev(`(() => { let n = 0, t = 0;
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices();
		if (vs.length == 3) t++; else if (f.getNormal(true).filter(v => Math.abs(v) > 0.01).length > 1) n++; }
	return JSON.stringify({ramps: n, triangles: t}); })()`), ' expect 1 ramp and 2 triangles');

// Pick the cell at column 1, row 0 of the atlas and paint the ramp with the brush
await ev(`(() => { BarItems.dew_texture_brush.select(); let s = DEWTileBrush.state; s.size = 16;
	DEWTileBrush.texture_state.atlas = {texture: Texture.all[0].uuid, x0: 16, y0: 0, x1: 16, y1: 0};
	return true; })()`);
await sleep(250);
await hover([24, 8, 8]);
console.log('B. hovering the ramp lights it up:', await ev(`!!Canvas.scene.getObjectByName('dew_tile_ghost')`), ' expect true');
await click([24, 8, 8]);
console.log('C. after painting the ramp:', await ev(loose));
console.log('   expect the ramp textured, its four corners carrying the corners of cell 16,0 to 32,16,');
console.log('   with uv v 0 on the top edge (16,16,0) and v 16 on the bottom edge (y 0), stretched down the slope');

// A cap triangle, from the +x side where it faces
await hover([32, 5, 5]);
await click([32, 5, 5]);
console.log('D. after painting a cap triangle:', await ev(loose));
console.log('   expect that triangle textured too, its three corners on three corners of the same cell');

// The bucket takes one as well
await ev(`(() => { BarItems.dew_paint_bucket.select();
	DEWTileBrush.texture_state.atlas = {texture: Texture.all[0].uuid, x0: 48, y0: 32, x1: 48, y1: 32};
	return true; })()`);
await sleep(250);
await hover([24, 8, 8]);
console.log('E. the bucket lights the ramp up too:', await ev(`!!Canvas.scene.getObjectByName('dew_tile_ghost')`), ' expect true');
await click([24, 8, 8]);
console.log('F. the ramp after the bucket:', await ev(`(() => { let r = v => Math.round(v * 100) / 100;
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices();
		if (vs.length != 4 || f.getNormal(true).filter(v => Math.abs(v) > 0.01).length < 2) continue;
		return JSON.stringify(vs.map(k => (f.uv[k] || []).map(r).join(',')).sort()); }
	return 'none'; })()`), ' expect the corners of cell 48,32 to 64,48');

await ev(`Undo.undo(); true`);
console.log('G. undo:', await ev(`(() => { let r = v => Math.round(v * 100) / 100;
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices();
		if (vs.length != 4 || f.getNormal(true).filter(v => Math.abs(v) > 0.01).length < 2) continue;
		return JSON.stringify(vs.map(k => (f.uv[k] || []).map(r).join(',')).sort()); }
	return 'none'; })()`), ' expect the brush cell 16,0 back');

// Clicking a cell again walks through the square and the two halves a triangle can take
await ev(`(() => { BarItems.dew_texture_brush.select(); DEWTileBrush.state.size = 16; DEWTileBrush.texture_state.atlas = null; return true; })()`);
await sleep(250);
const pick = (x, y) => `(() => { let t = Texture.all[0]; Toolbox.selected.onAtlasClick(t, {x: ${x}, y: ${y}});
	document.dispatchEvent(new PointerEvent('pointerup'));
	let a = DEWTileBrush.texture_state.atlas;
	return JSON.stringify({cell: [Math.floor(a.x0 / 16), Math.floor(a.y0 / 16)], shape: a.shape}); })()`;
console.log('H. clicking one cell over and over:');
console.log('   first:', await ev(pick(20, 4)), ' expect cell 1,0 square');
console.log('   again:', await ev(pick(20, 4)), ' expect ul');
console.log('   again:', await ev(pick(20, 4)), ' expect lr');
console.log('   again:', await ev(pick(20, 4)), ' expect square again');
console.log('   another cell:', await ev(pick(52, 4)), ' expect cell 3,0 square');

// The cap triangle lands on the lower right half of a cell, so asking for the upper left turns the art around
const triangleUV = `(() => { let r = v => Math.round(v * 100) / 100;
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices();
		if (vs.length != 3) continue;
		if (!vs.map(k => m.vertices[k].map(r).join(',')).includes('32,0,0')) continue;
		return JSON.stringify(vs.map(k => (f.uv[k] || []).map(r).join(',')).sort()); }
	return 'none'; })()`;
await ev(`(() => { DEWTileBrush.texture_state.atlas = {texture: Texture.all[0].uuid, x0: 16, y0: 0, x1: 16, y1: 0, shape: 'lr'}; return true; })()`);
await hover([32, 5, 5]);
await click([32, 5, 5]);
console.log('I. that triangle with the lr half picked:', await ev(triangleUV), ' expect 16,16 / 32,0 / 32,16, the half it sits on');
await ev(`(() => { DEWTileBrush.texture_state.atlas = {texture: Texture.all[0].uuid, x0: 16, y0: 0, x1: 16, y1: 0, shape: 'ul'}; return true; })()`);
await hover([32, 5, 5]);
await click([32, 5, 5]);
console.log('J. the same triangle with the ul half picked:', await ev(triangleUV), ' expect 16,0 / 16,16 / 32,0, the other half of the cell');

// A square pick still lays the whole cell over a ramp, halves are a triangle thing
await ev(`(() => { DEWTileBrush.texture_state.atlas = {texture: Texture.all[0].uuid, x0: 16, y0: 0, x1: 16, y1: 0, shape: 'ul'}; return true; })()`);
await hover([24, 8, 8]);
await click([24, 8, 8]);
console.log('K. a ramp with a half picked:', await ev(`(() => { let r = v => Math.round(v * 100) / 100;
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices();
		if (vs.length != 4 || f.getNormal(true).filter(v => Math.abs(v) > 0.01).length < 2) continue;
		return JSON.stringify(vs.map(k => (f.uv[k] || []).map(r).join(',')).sort()); }
	return 'none'; })()`), ' expect all four corners of the cell: a quad takes the whole square');

console.log('page errors:', errors.length ? errors : 'none');
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_paint_loose.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
