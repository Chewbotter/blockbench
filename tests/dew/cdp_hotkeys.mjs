// The number keys pick the tile tools in DEW scenes, and deselect all clears everything there.
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
async function press(key, code, vk) {
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
	await sleep(180);
}
const digit = n => press(String(n), 'Digit' + n, 48 + n);

// A floor to select, so a mesh is selected while the keys are pressed: that is when the selection mode
// shortcuts would otherwise fire on the same keys
const build = `(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove());
	let m = new Mesh({name: 'floor', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	for (let x = 0; x < 32; x += 16) for (let z = 0; z < 32; z += 16) {
		let pt = (dx, dz) => [x + dx, 0, z + dz];
		let f = new MeshFace(m, {vertices: [pt(0,0), pt(16,0), pt(16,16), pt(0,16)].map(vert), texture: false});
		m.addFaces(f); if (f.getNormal(true)[1] < 0) f.invert(); }
	m.init(); m.select(); updateSelection(); return Object.keys(m.faces).length; })()`;
await ev(build);
await sleep(400);
console.log('a floor is up and selected:', await ev(`JSON.stringify({selected: Mesh.selected.length, tool: Toolbox.selected.id})`));

for (let [n, tool] of [[1, 'dew_tile_select'], [2, 'dew_whole_block'], [3, 'dew_tile_brush'], [4, 'dew_texture_brush'], [5, 'dew_paint_bucket'], [6, 'dew_terrain']]) {
	await digit(n);
	console.log(`${n}:`, await ev(`JSON.stringify({tool: Toolbox.selected.id, mode: BarItems.selection_mode.value})`), ` expect ${tool}`);
}
console.log('   and the mode each one wanted is the mode it kept: nothing else claimed the key');

// The selection mode shortcuts stand down here and nowhere else
console.log('A. selection mode offered, DEW scene:', await ev(`Condition(BarItems.selection_mode.condition)`), ' expect false');
console.log('B. selection mode offered, generic model:', await ev(`(() => { newProject(Formats.free);
	let m = new Mesh({name: 'thing', vertices: {}});
	let k = [[0,0,0],[16,0,0],[16,0,16],[0,0,16]].map(v => m.addVertices(v)[0]);
	m.addFaces(new MeshFace(m, {vertices: k})); m.init(); m.select(); updateSelection();
	return Condition(BarItems.selection_mode.condition); })()`), ' expect true: other formats keep their number keys');

// Deselect all, which the backtick runs, has to clear everything whatever is active
const selection = `(() => { let faces = 0;
	for (let mesh of Mesh.all) faces += (Project.mesh_selection[mesh.uuid]?.faces || []).length;
	return JSON.stringify({elements: Outliner.selected.length, faces, mode: BarItems.selection_mode.value}); })()`;
const selectSome = `(() => { let m = Mesh.all[0]; BarItems.selection_mode.set('face'); m.select();
	let keys = Object.keys(m.faces);
	m.getSelectedFaces(true).replace(keys);
	m.getSelectedVertices(true).replace([...new Set(keys.flatMap(k => m.faces[k].vertices))]);
	updateSelection(); return true; })()`;

await ev(build);
await sleep(400);
await ev(`(() => { BarItems.dew_tile_select.select(); return true; })()`);
await sleep(250);
await ev(selectSome);
console.log('C. tiles selected with the select tool:', await ev(selection), ' expect 4 faces, in face mode');
await ev(`(() => { SharedActions.run('unselect_all'); return true; })()`);
await sleep(250);
console.log('   after deselect all:', await ev(selection), ' expect nothing selected, no faces left over');

// The same from a tool that works in object mode, where the stock handler would only have cleared elements
await ev(selectSome);
await ev(`(() => { BarItems.dew_tile_brush.select(); return true; })()`);
await sleep(300);
console.log('D. tiles still selected under the tile brush:', await ev(selection), ' expect 4 faces, now in object mode');
await ev(`(() => { SharedActions.run('unselect_all'); return true; })()`);
await sleep(250);
console.log('   after deselect all:', await ev(selection), ' expect nothing selected and no faces held on to');

// Undo does not put a deselect back, here or for the stock deselect in other formats, which was checked
// against a generic model. Written down so a later run does not read it as a regression.
console.log('   undo selections setting:', await ev(`settings.undo_selections.value`));
await ev(`Undo.undo(); true`);
await sleep(250);
console.log('E. undo after deselecting:', await ev(selection), ' expect still nothing selected: a deselect is not undone');

console.log('page errors:', errors.length ? errors : 'none');
ws.close();
