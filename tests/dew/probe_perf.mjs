// Performance probe on a mid-poly mesh: where the time goes at N faces. Builds a grid of quads and times the paths
// an edit session hits: selection change in object and face mode, a full geometry rebuild, a vertex-only update,
// an undo entry, a hover raycast, the UV panel. Run: node tests/dew/run_cdp.mjs tests/dew/probe_perf.mjs --fresh --isolated
// FACES=10000 (default) sets the size.
const FACES = Number(process.env.FACES || 10000);
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

const side = Math.round(Math.sqrt(FACES));
console.log(`building a ${side} x ${side} grid of quads (${side * side} faces, ${2 * side * side} tris)`);
console.log('build ms:', await ev(`(() => { newProject(Formats.free); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove());
	let t0 = performance.now(); let m = new Mesh({name: 'grid', vertices: {}}); let keys = [];
	for (let z = 0; z <= ${side}; z++) { keys.push([]); for (let x = 0; x <= ${side}; x++) keys[z].push(m.addVertices([x * 4, Math.sin(x * 0.3) * 4 + Math.cos(z * 0.3) * 4, z * 4])[0]); }
	for (let z = 0; z < ${side}; z++) for (let x = 0; x < ${side}; x++) { let vs = [keys[z][x], keys[z][x + 1], keys[z + 1][x + 1], keys[z + 1][x]]; let uv = {}; vs.forEach(v => uv[v] = [m.vertices[v][0] % 64, m.vertices[v][2] % 64]); m.addFaces(new MeshFace(m, {vertices: vs, uv, texture: false})); }
	m.init(); unselectAllElements(); updateSelection();
	let p = Preview.selected; p.controls.target.set(${side * 2}, 0, ${side * 2}); p.camera.position.set(${side * 2}, ${side * 3}, ${side * 4}); p.controls.update(); if (p.render) p.render();
	return Math.round(performance.now() - t0); })()`));
await sleep(500);
const time = async (label, expr, repeat = 3) => {
	let times = [];
	for (let i = 0; i < repeat; i++) times.push(await ev(`(() => { let t0 = performance.now(); ${expr}; return performance.now() - t0; })()`));
	console.log(`${label}: ${times.map(t => Math.round(t)).join(' / ')} ms`);
};
await ev(`BarItems.selection_mode.set('object'); true`);
await time('select mesh, object mode (updateSelection)', `unselectAllElements(); Mesh.all[0].select(); updateSelection()`);
await time('UV panel refresh, object mode', `UVEditor.vue.updateTexture(); UVEditor.loadData()`);
await time('full geometry rebuild (updateView geometry)', `Canvas.updateView({elements: [Mesh.all[0]], element_aspects: {geometry: true, faces: true, uv: true}})`);
await time('preview_controller.updateGeometry alone', `Mesh.all[0].preview_controller.updateGeometry(Mesh.all[0])`);
await time('vertex nudge + rebuild (one drag frame today)', `let m = Mesh.all[0]; for (let k in m.vertices) m.vertices[k][1] += 0.01; Canvas.updateView({elements: [m], element_aspects: {geometry: true}})`);
await time('undo entry (initEdit + finishEdit)', `Undo.initEdit({elements: [Mesh.all[0]]}); Undo.finishEdit('probe')`);
await time('undo + redo', `Undo.undo(); Undo.redo()`);
await time('hover raycast at the viewport centre', `let p = Preview.selected; let r = p.canvas.getBoundingClientRect(); p.raycast({clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, target: p.canvas})`, 5);
await time('status bar poly count', `Interface.status_bar.vue.updatePolyInfo()`);
await time('getSortedVertices over every face', `let m = Mesh.all[0]; for (let k in m.faces) m.faces[k].getSortedVertices()`);
await time('getNormal over every face', `let m = Mesh.all[0]; for (let k in m.faces) m.faces[k].getNormal(true)`);
await ev(`BarItems.selection_mode.set('face'); true`);
await time('select mesh, face mode (updateSelection)', `unselectAllElements(); Mesh.all[0].select(); updateSelection()`, 2);
await time('select all faces, face mode', `let m = Mesh.all[0]; m.getSelectedFaces(true).replace(Object.keys(m.faces)); updateSelection()`, 2);
await time('UV panel refresh, face mode, all faces selected', `UVEditor.vue.updateTexture(); UVEditor.loadData()`, 2);
console.log('UV DOM nodes:', await ev(`document.querySelectorAll('#uv_frame *').length`));
await time('transformer update (gizmo repositions)', `Transformer.updateSelection()`);
await ev(`BarItems.selection_mode.set('object'); unselectAllElements(); updateSelection(); true`);
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
