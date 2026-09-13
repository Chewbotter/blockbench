// Add DEW Block: a new element with one block on the grid at the orbit point, and Whole Block keeping separate
// elements separate (no culling across them).
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
async function click(world, modifiers = 0) {
	const at = await screen(...world);
	await mouse('mouseMoved', at, { button: 'none', modifiers }); await sleep(90);
	await mouse('mouseMoved', at, { button: 'none', modifiers }); await sleep(70);
	await mouse('mousePressed', at, { buttons: 1, modifiers }); await sleep(70);
	await mouse('mouseReleased', at, { modifiers }); await sleep(220);
}
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); if (p.render) p.render(); return true; })()`);
	await sleep(170);
};
// Faces and box per element
const elements = `(() => { let r = v => Math.round(v * 100) / 100; let out = {};
	for (let m of Mesh.all) { let box = null; let n = 0;
		for (let fkey in m.faces) { n++; for (let k of m.faces[fkey].vertices) { let p = m.vertices[k].map(r);
			if (!box) box = {min: p.slice(), max: p.slice()};
			for (let i = 0; i < 3; i++) { box.min[i] = Math.min(box.min[i], p[i]); box.max[i] = Math.max(box.max[i], p[i]); } } }
		out[m.name + (out[m.name] ? '_2' : '')] = {faces: n, box: box && [box.min.join(','), box.max.join(',')]}; }
	return JSON.stringify({elements: out, selected: Mesh.selected.map(m => m.name)}); })()`;

await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove()); unselectAllElements(); updateSelection(); return true; })()`);
await sleep(400);
console.log('A. offered:', await ev(`JSON.stringify({condition: Condition(BarItems.dew_add_block.condition), first_in_add_menu: BarItems.add_element.side_menu.structure[0]})`));
console.log('   expect condition true, first_in_add_menu dew_add_block');

await camera(100, 0, 60, 200, 120, 200);
await ev(`(() => { DEWTileBrush.state.size = 16; BarItems.dew_add_block.click(); return true; })()`);
await sleep(200);
console.log('B. half size at orbit 100,0,60:', await ev(elements));
console.log('   expect block with 6 faces from 96,0,48 to 112,16,64, selected');
await ev(`Undo.undo(); true`);
console.log('C. undo:', await ev(elements), ' expect no elements');

await ev(`(() => { DEWTileBrush.state.size = 32; BarItems.dew_add_block.click(); return true; })()`);
await sleep(200);
console.log('D. full size:', await ev(elements));
console.log('   expect block with 24 faces from 96,0,32 to 128,32,64');

// Two separate elements: a block drawn into B against A leaves A whole and gets its own wall
await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove()); unselectAllElements(); updateSelection(); DEWTileBrush.state.size = 16; return true; })()`);
await sleep(400);
await camera(8, 0, 8, 96, 70, 96);
await ev(`(() => { BarItems.dew_add_block.click(); Mesh.selected[0].name = 'A'; return true; })()`);
await camera(200, 0, 200, 300, 70, 300);
await ev(`(() => { BarItems.dew_add_block.click(); Mesh.selected[0].name = 'B'; return true; })()`);
await camera(16, 8, 8, 96, 70, 96);
await ev(`(() => { BarItems.dew_whole_block.select(); DEWTileBrush.state.size = 16; return true; })()`);
await sleep(300);
await click([16, 8, 8]);
console.log('E. a block in B against A:', await ev(elements));
console.log('   expect A 6 faces untouched, B 12 faces (its own wall on x 16 kept), B still selected');
await click([32, 8, 8], 2);
console.log('F. ctrl removes it:', await ev(elements));
console.log('   expect A 6 faces, B 6 faces');

console.log('page errors:', errors.length ? errors : 'none');
ws.close();
