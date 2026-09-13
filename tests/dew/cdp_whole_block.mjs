// Whole Block: a cube per click, faces where blocks meet dropped on both sides, and Ctrl taking one back out.
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
const hover = async (world, modifiers = 0) => { await mouse('mouseMoved', await screen(...world), { button: 'none', modifiers }); await sleep(90); };
async function click(world, modifiers = 0) {
	const at = await screen(...world);
	await mouse('mouseMoved', at, { button: 'none', modifiers }); await sleep(70);
	await mouse('mousePressed', at, { buttons: 1, modifiers }); await sleep(70);
	await mouse('mouseReleased', at, { modifiers }); await sleep(220);
}
async function dragWorld(from, to, steps = 10) {
	const a = await screen(...from), b = await screen(...to);
	await mouse('mouseMoved', a, { button: 'none' }); await sleep(70);
	await mouse('mousePressed', a, { buttons: 1 }); await sleep(70);
	for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps], { buttons: 1 }); await sleep(30); }
	await mouse('mouseReleased', b); await sleep(250);
}
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); if (p.render) p.render(); return true; })()`);
	await sleep(170);
};
// How many faces there are, which way they point, and the box they span
const shape = `(() => { let r = v => Math.round(v * 100) / 100; let per = {}; let box = null; let total = 0;
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices();
		if (vs.length != 4) continue;
		total++;
		let n = f.getNormal(true).map(r).join(',');
		per[n] = (per[n] || 0) + 1;
		for (let k of vs) { let p = m.vertices[k].map(r);
			if (!box) box = {min: p.slice(), max: p.slice()};
			for (let i = 0; i < 3; i++) { box.min[i] = Math.min(box.min[i], p[i]); box.max[i] = Math.max(box.max[i], p[i]); } } }
	return JSON.stringify({faces: total, per, box}); })()`;

await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove()); unselectAllElements(); updateSelection(); return true; })()`);
await sleep(400);
await camera(16, 8, 8, 96, 70, 96);
await ev(`(() => { BarItems.dew_whole_block.select(); let s = DEWTileBrush.state; s.size = 16; s.axis = 'y'; s.depth = 0; s.sign = null; return true; })()`);
await sleep(300);
console.log('setup:', await ev(`JSON.stringify({tool: Toolbox.selected.id, size: DEWTileBrush.state.size, order: Toolbars.tools.children.map(c => c.id).filter(id => id.startsWith('dew_')).slice(0, 3)})`));
console.log('   expect dew_whole_block between select and brush');
await hover([8, 0, 8]);
console.log('A. ghost before placing:', await ev(`!!Canvas.scene.getObjectByName('dew_tile_ghost')`), ' expect true');

await click([8, 0, 8]);
console.log('B. one block:', await ev(shape));
console.log('   expect 6 faces, one each way, box 0,0,0 to 16,16,16: it sits on the plane, on the camera side');

// Against its +x side, which should drop the two faces that meet
await hover([16, 8, 8]);
await click([16, 8, 8]);
console.log('C. a second block against it:', await ev(shape));
console.log('   expect 10 faces: the wall on x 16 is between two solids, so neither block keeps one there,');
console.log('   and the box runs to x 32');

// Ctrl takes the second one out and gives the first its wall back
await hover([32, 8, 8], 2);
await click([32, 8, 8], 2);
console.log('D. ctrl removes it again:', await ev(shape));
console.log('   expect 6 faces, one each way, and the box back to 16 across: the first block has its wall back');

await ev(`Undo.undo(); true`);
console.log('E. undo brings it back:', await ev(shape), ' expect 10 faces again');
await ev(`Undo.undo(); true`);

// A drag lays a run along the plane it started on
await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove()); unselectAllElements(); updateSelection(); return true; })()`);
await sleep(400);
await camera(48, 8, 8, 150, 90, 150);
await ev(`(() => { BarItems.dew_whole_block.select(); let s = DEWTileBrush.state; s.size = 16; s.axis = 'y'; s.depth = 0; return true; })()`);
await sleep(300);
await hover([8, 0, 8]);
await dragWorld([8, 0, 8], [104, 0, 8]);
console.log('F. a drag along the plane:', await ev(shape));
console.log('   expect a row of blocks, x running 0 to over 96, and only the two end walls facing along x (1,0,0 and -1,0,0 at 1 each)');

// Mid drag the ghost stays on the block just laid instead of jumping onto its top
await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove()); unselectAllElements(); updateSelection(); return true; })()`);
await sleep(400);
await camera(48, 8, 8, 150, 90, 150);
await ev(`(() => { BarItems.dew_whole_block.select(); let s = DEWTileBrush.state; s.size = 16; s.axis = 'y'; s.depth = 0; return true; })()`);
await sleep(300);
{
	const a = await screen(8, 0, 8), b = await screen(40, 0, 8);
	await mouse('mouseMoved', a, { button: 'none' }); await sleep(70);
	await mouse('mousePressed', a, { buttons: 1 }); await sleep(70);
	for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / 8, a[1] + (b[1] - a[1]) * i / 8], { buttons: 1 }); await sleep(30); }
	await mouse('mouseMoved', b, { buttons: 1 }); await sleep(90);
	console.log('F2. ghost mid drag:', await ev(`JSON.stringify(Canvas.scene.getObjectByName('dew_tile_ghost')?.position.toArray())`));
	console.log('   expect [40,8,8]: on the block under the cursor, not [40,24,8] on top of it');
	await mouse('mouseReleased', b); await sleep(250);
}

// Full size blocks are four half cell tiles a side
await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove()); unselectAllElements(); updateSelection();
	BarItems.dew_whole_block.select(); let s = DEWTileBrush.state; s.size = 32; s.axis = 'y'; s.depth = 0; return true; })()`);
await sleep(400);
await camera(16, 16, 16, 120, 90, 120);
await hover([16, 0, 16]);
await click([16, 0, 16]);
console.log('G. a full size block:', await ev(shape));
console.log('   expect 24 faces, four a side, box 0,0,0 to 32,32,32');

// A block landing on a lone tile eats it, and there is nothing left to seal against on the way out
await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove());
	let m = new Mesh({name: 'floor', vertices: {}});
	let k = [[0,0,0],[16,0,0],[16,0,16],[0,0,16]].map(v => m.addVertices(v)[0]);
	let f = new MeshFace(m, {vertices: k, texture: false}); m.addFaces(f);
	if (f.getNormal(true)[1] < 0) f.invert();
	m.init(); unselectAllElements(); updateSelection();
	BarItems.dew_whole_block.select(); let s = DEWTileBrush.state; s.size = 16; s.axis = 'y'; s.depth = 0; return true; })()`);
await sleep(400);
await camera(8, 8, 8, 90, 70, 90);
await hover([8, 0, 8]);
await click([8, 0, 8]);
console.log('H. a block dropped onto a single floor tile:', await ev(shape));
console.log('   expect 6 faces: the tile stays and stands in for the block underside, which is not added');
await hover([8, 16, 8], 2);
await click([8, 16, 8], 2);
console.log('I. ctrl removes that block again:', await ev(shape));
console.log('   expect the tile still there, 1 face: only what faced out of the cell belonged to the block');

// Ctrl on flat ground takes what is in the cursor's cell and builds nothing under it
await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove());
	let m = new Mesh({name: 'floor', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	for (let x = 0; x < 32; x += 16) for (let z = 0; z < 32; z += 16) {
		let pt = (dx, dz) => [x + dx, 0, z + dz];
		let f = new MeshFace(m, {vertices: [pt(0,0), pt(16,0), pt(16,16), pt(0,16)].map(vert), texture: false});
		m.addFaces(f); if (f.getNormal(true)[1] < 0) f.invert(); }
	m.init(); unselectAllElements(); updateSelection();
	BarItems.dew_whole_block.select(); let s = DEWTileBrush.state; s.size = 16; s.axis = 'y'; s.depth = 0; return true; })()`);
await sleep(400);
await camera(16, 0, 16, 110, 90, 110);
console.log('L. a floor of four tiles:', await ev(shape), ' expect 4 faces, all facing up');
await hover([8, 0, 8], 2);
await click([8, 0, 8], 2);
console.log('M. ctrl on one of them:', await ev(shape));
console.log('   expect 3 faces, all still facing up: the tile under the cursor goes, and nothing is hung underneath');

// Three blocks laid on a floor and then taken back off: the floor has to survive all of it
await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove());
	let m = new Mesh({name: 'floor', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	for (let x = 0; x < 48; x += 16) for (let z = 0; z < 32; z += 16) {
		let pt = (dx, dz) => [x + dx, 0, z + dz];
		let f = new MeshFace(m, {vertices: [pt(0,0), pt(16,0), pt(16,16), pt(0,16)].map(vert), texture: false});
		m.addFaces(f); if (f.getNormal(true)[1] < 0) f.invert(); }
	m.init(); unselectAllElements(); updateSelection();
	BarItems.dew_whole_block.select(); let s = DEWTileBrush.state; s.size = 16; s.axis = 'y'; s.depth = 0; return true; })()`);
await sleep(400);
await camera(24, 8, 8, 150, 110, 150);
console.log('N. a floor of six tiles:', await ev(shape), ' expect 6 faces, all facing up');
for (let x of [8, 24, 40]) { await hover([x, 0, 8]); await click([x, 0, 8]); }
console.log('O. three blocks on it:', await ev(shape));
console.log('   expect 17 faces: the six floor tiles plus 11 block faces, no walls between the blocks and no undersides added');
for (let x of [8, 24, 40]) { await hover([x, 16, 8], 2); await click([x, 16, 8], 2); }
console.log('P. all three culled with ctrl:', await ev(shape));
console.log('   expect the six floor tiles and nothing else: no holes in the floor, no walls left standing');

// An atlas pick textures every side of a new block, and a two cell pick alternates along a row
await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove()); unselectAllElements(); updateSelection();
	BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(800);
await camera(8, 8, 8, 90, 70, 90);
await ev(`(() => { BarItems.dew_whole_block.select(); let s = DEWTileBrush.state; s.size = 16; s.axis = 'y'; s.depth = 0;
	DEWTileBrush.texture_state.atlas = {texture: Texture.all[0].uuid, x0: 16, y0: 0, x1: 16, y1: 0, shape: 'square'}; return true; })()`);
await sleep(300);
const painted = `(() => { let t = Texture.all[0]; let textured = 0, total = 0, corners = {};
	for (let m of Mesh.all) for (let k in m.faces) { let f = m.faces[k]; total++; if (f.texture == t.uuid) textured++;
		let uvs = f.vertices.map(v => f.uv[v] || [NaN, NaN]); let c = Math.min(...uvs.map(u => u[0])) + ',' + Math.min(...uvs.map(u => u[1]));
		let spans = Math.max(...uvs.map(u => u[0])) - Math.min(...uvs.map(u => u[0]));
		let key = f.getNormal(true).map(Math.round).join(',') + ' @' + c + ' w' + spans; corners[key] = (corners[key] || 0) + 1; }
	return JSON.stringify({picker: !!BarItems.dew_whole_block.atlas_picker, textured, total, corners}); })()`;
await hover([8, 0, 8]);
await click([8, 0, 8]);
console.log('Q. a block with cell 1,0 picked:', await ev(painted));
console.log('   expect picker true, 6 of 6 textured, every face @16,0 w16');
await ev(`(() => { Mesh.all.slice().forEach(m => m.remove()); DEWTileBrush.texture_state.atlas.x0 = 0; return true; })()`);
await camera(48, 8, 8, 150, 90, 150);
await hover([8, 0, 8]);
await dragWorld([8, 0, 8], [72, 0, 8], 8);
console.log('R. a row with a two cell pick:', await ev(painted));
console.log('   expect all textured, and the faces facing up split between @0,0 and @16,0, alternating block by block');

console.log('page errors:', errors.length ? errors : 'none');
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_whole_block.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
