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

await ev(`(() => { newProject(Formats.dew_scene); unselectAllElements(); updateSelection(); return true; })()`);
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
console.log('   expect 10 faces, not 12: the pair on x 16 cancelled, and the box now runs to x 32');

// Ctrl takes the second one out and gives the first its wall back
await hover([32, 8, 8], 2);
await click([32, 8, 8], 2);
console.log('D. ctrl removes it again:', await ev(shape));
console.log('   expect 6 faces and the box back to 16 across: the wall between them was sealed on the way out');

await ev(`Undo.undo(); true`);
console.log('E. undo brings it back:', await ev(shape), ' expect 10 faces again');
await ev(`Undo.undo(); true`);

// A drag lays a run along the plane it started on
await ev(`(() => { newProject(Formats.dew_scene); unselectAllElements(); updateSelection(); return true; })()`);
await sleep(400);
await camera(48, 8, 8, 150, 90, 150);
await ev(`(() => { BarItems.dew_whole_block.select(); let s = DEWTileBrush.state; s.size = 16; s.axis = 'y'; s.depth = 0; return true; })()`);
await sleep(300);
await hover([8, 0, 8]);
await dragWorld([8, 0, 8], [104, 0, 8]);
console.log('F. a drag along the plane:', await ev(shape));
console.log('   expect a row of blocks, x running 0 to over 96, and far fewer faces than 6 a block: the walls between them are gone');

// Full size blocks are four half cell tiles a side
await ev(`(() => { newProject(Formats.dew_scene); unselectAllElements(); updateSelection();
	BarItems.dew_whole_block.select(); let s = DEWTileBrush.state; s.size = 32; s.axis = 'y'; s.depth = 0; return true; })()`);
await sleep(400);
await camera(16, 16, 16, 120, 90, 120);
await hover([16, 0, 16]);
await click([16, 0, 16]);
console.log('G. a full size block:', await ev(shape));
console.log('   expect 24 faces, four a side, box 0,0,0 to 32,32,32');

// A block landing on a lone tile eats it, and there is nothing left to seal against on the way out
await ev(`(() => { newProject(Formats.dew_scene);
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
console.log('   expect 5 faces: the tile and the block underside met and both went, so the block has no floor');
await hover([8, 16, 8], 2);
await click([8, 16, 8], 2);
console.log('I. ctrl removes that block again:', await ev(shape));
console.log('   expect nothing left: the tile was on its own, so there was no neighbour to seal against and it');
console.log('   does not come back. Undo is the way back from that one');

console.log('page errors:', errors.length ? errors : 'none');
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_whole_block.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
