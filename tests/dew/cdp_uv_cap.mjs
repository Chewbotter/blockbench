// The UV panel's face cap: select-all in face mode on a 10k face mesh draws at most max_displayed_faces faces and
// says so; a small mesh is unaffected; a UV move still applies to every selected face, drawn or not.
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

const build = side => `(() => { newProject(Formats.free); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove());
	let m = new Mesh({name: 'grid', vertices: {}}); let keys = [];
	for (let z = 0; z <= ${side}; z++) { keys.push([]); for (let x = 0; x <= ${side}; x++) keys[z].push(m.addVertices([x * 4, 0, z * 4])[0]); }
	for (let z = 0; z < ${side}; z++) for (let x = 0; x < ${side}; x++) { let vs = [keys[z][x], keys[z][x + 1], keys[z + 1][x + 1], keys[z + 1][x]]; let uv = {}; vs.forEach(v => uv[v] = [x % 64, z % 64]); m.addFaces(new MeshFace(m, {vertices: vs, uv, texture: false})); }
	m.init(); unselectAllElements(); updateSelection(); if (Panels.uv.folded) Panels.uv.fold(false); BarItems.selection_mode.set('face'); return true; })()`;
const settle = expr => ev(`new Promise(done => { let t0 = performance.now(); ${expr}; Vue.nextTick(() => requestAnimationFrame(() => done(JSON.stringify({ms: Math.round(performance.now() - t0), nodes: document.querySelectorAll('#uv_frame *').length, faces_drawn: document.querySelectorAll('#uv_frame .mesh_uv_face').length, note: document.querySelector('#uv_frame .uv_face_cap_note')?.textContent.trim() || ''})))); })`);

await ev(build(100)); await sleep(400);
console.log('cap:', await ev(`UVEditor.max_displayed_faces`), ' expect 2000');
console.log('A. select all 10k faces:', await settle(`let m = Mesh.all[0]; m.select(); m.getSelectedFaces(true).replace(Object.keys(m.faces)); updateSelection()`));
console.log('   expect faces_drawn 2000, nodes about 14k, ms well under 1000, the note naming 2000 of 10000');
console.log('B. a UV move still applies to all 10000:', await ev(`(() => { let m = Mesh.all[0]; let before = Object.values(m.faces).map(f => f.uv[f.vertices[0]][0]); UVEditor.moveSelection([3, 0], {shiftKey: false, ctrlOrCmd: false}); let moved = Object.values(m.faces).filter((f, i) => Math.abs(f.uv[f.vertices[0]][0] - before[i] - 3) < 1e-6).length; Undo.undo(); return JSON.stringify({moved}); })()`), ' expect moved 10000');
console.log('C. one face selected:', await settle(`let m = Mesh.all[0]; m.getSelectedFaces(true).replace([Object.keys(m.faces)[5]]); updateSelection()`), ' expect faces_drawn 1, no note');
await ev(build(30)); await sleep(400);
console.log('D. a 900 face mesh, all selected, is untouched by the cap:', await settle(`let m = Mesh.all[0]; m.select(); m.getSelectedFaces(true).replace(Object.keys(m.faces)); updateSelection()`), ' expect faces_drawn 900, no note');
await ev(`BarItems.selection_mode.set('object'); unselectAllElements(); updateSelection(); true`);
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
