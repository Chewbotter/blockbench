// Face mode, shift held: a drag starting on a face paints faces into the selection; a drag starting over nothing
// draws a rectangle whose faces are added; a shift click on nothing changes nothing. All three keep what was selected.
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
const SHIFT = 8;
const screen = async (x, y, z) => JSON.parse(await ev(`(() => { let p = Preview.selected; let v = new THREE.Vector3(${x}, ${y}, ${z}).project(p.camera); let r = p.canvas.getBoundingClientRect(); return JSON.stringify([r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]); })()`));
const mouse = (type, [x, y], extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
async function drag(from, to, modifiers, steps = 12) {
	const a = await screen(...from), b = await screen(...to);
	for (let i = 0; i < 2; i++) { await mouse('mouseMoved', a, { button: 'none', modifiers }); await sleep(60); }
	await mouse('mousePressed', a, { buttons: 1, modifiers }); await sleep(60);
	for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps], { buttons: 1, modifiers }); await sleep(30); }
	await mouse('mouseReleased', b, { modifiers }); await sleep(300);
}

// An 8 x 8 floor of 16 unit quads at y 0, seen from straight above, in face mode with the move tool
await ev(`(() => { newProject(Formats.free); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove());
	let m = new Mesh({name: 'floor', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	for (let x = 0; x < 128; x += 16) for (let z = 0; z < 128; z += 16) { let f = new MeshFace(m, {vertices: [[x,0,z],[x+16,0,z],[x+16,0,z+16],[x,0,z+16]].map(vert), texture: false}); m.addFaces(f); if (f.getNormal(true)[1] < 0) f.invert(); }
	m.init(); BarItems.move_tool.select(); m.select(); BarItems.selection_mode.set('face');
	let keys = Object.keys(m.faces); m.getSelectedFaces(true).replace([keys[0], keys[1]]); updateSelection();
	let p = Preview.selected; p.controls.target.set(64, 0, 64); p.camera.position.set(64, 400, 64.01); p.controls.update(); if (p.render) p.render(); return true; })()`);
await sleep(400);
// Selected faces as their min corners, sorted
const sel = `(() => { let m = Mesh.all[0]; let faces = m.getSelectedFaces().map(k => { let ps = m.faces[k].vertices.map(v => m.vertices[v]); return [0, 2].map(i => Math.min(...ps.map(p => p[i]))).join(','); }).sort(); return JSON.stringify({count: faces.length, faces}); })()`;
console.log('start:', await ev(sel), ' expect 2 faces, 0,0 and 0,16');

// A. shift drag starting on a face: paints along the path (the existing brush), keeping the two
await drag([72, 0, 40], [72, 0, 100], SHIFT);
console.log('A. shift brush from a face:', await ev(sel), ' expect the two plus the faces along x 64 between z 32 and 96 (about 6 in all)');

// B. shift drag starting over nothing (off the floor, x negative) sweeping a box over the far corner
await drag([-40, 0, -40], [40, 0, 40], SHIFT);
console.log('B. shift box from empty space:', await ev(sel), ' expect all of A plus the faces inside x 0..32, z 0..32 (0,0 0,16 16,0 16,16), nothing lost');

// C. a shift click on nothing changes nothing
await drag([-60, 0, 60], [-60, 0, 60], SHIFT, 1);
console.log('C. shift click on nothing:', await ev(sel), ' expect unchanged');

// D. the camera did not move under the box (shift + left is the zoom binding when over nothing)
console.log('D. camera unchanged after the shift box:', await ev(`(() => { let p = Preview.selected; return JSON.stringify({pos: p.camera.position.toArray().map(Math.round), controls_enabled: p.controls.enabled}); })()`), ' expect pos [64, 400, 64], controls_enabled true');
// E. a plain press and release on nothing still clears the face selection (stock behaviour kept)
{ const at = await screen(-60, 0, 60); await mouse('mouseMoved', at, { button: 'none' }); await sleep(60); await mouse('mousePressed', at, { buttons: 1 }); await sleep(60); await mouse('mouseReleased', at, {}); await sleep(300); }
console.log('E. plain click on nothing:', await ev(sel), ' expect 0 faces');
// F. a Ctrl box (the stock area select): the UV panel draws no faces mid-drag and the selection on release
{
	await ev(`(() => { if (Panels.uv.folded) Panels.uv.fold(false); let m = Mesh.all[0]; m.select(); m.getSelectedFaces(true).empty(); updateSelection(); return true; })()`);
	await sleep(300);
	const a = await screen(-24, 0, -24), b = await screen(56, 0, 56);	// from empty space onto the mesh, as a box is drawn in practice
	for (let i = 0; i < 2; i++) { await mouse('mouseMoved', a, { button: 'none', modifiers: 2 }); await sleep(60); }
	await mouse('mousePressed', a, { buttons: 1, modifiers: 2 }); await sleep(60);
	for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / 8, a[1] + (b[1] - a[1]) * i / 8], { buttons: 1, modifiers: 2 }); await sleep(40); }
	const mid = await ev(`new Promise(done => Vue.nextTick(() => done(JSON.stringify({rect_active: !!Preview.selected.sr_move_f, faces_selected: Mesh.all[0].getSelectedFaces().length, uv_faces_drawn: document.querySelectorAll('#uv_frame .mesh_uv_face').length}))))`);
	await mouse('mouseReleased', b, { modifiers: 2 }); await sleep(400);
	const after = await ev(`new Promise(done => Vue.nextTick(() => requestAnimationFrame(() => done(JSON.stringify({rect_active: !!Preview.selected.sr_move_f, faces_selected: Mesh.all[0].getSelectedFaces().length, uv_draws_again: document.querySelectorAll('#uv_frame .mesh_uv_face').length > 0, vertices_unique: new Set(Mesh.all[0].getSelectedVertices()).size == Mesh.all[0].getSelectedVertices().length})))))`);
	console.log('F. ctrl box mid-drag:', mid, ' expect rect_active true, faces selected, uv_faces_drawn 0');
	console.log('   on release:', after, ' expect rect_active false, the same faces, uv_draws_again true (how many depends on the display_uv setting), vertices_unique true');
}
await ev(`BarItems.selection_mode.set('object'); unselectAllElements(); updateSelection(); true`);
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
