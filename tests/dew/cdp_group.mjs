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

const state = `(() => { let out = {}; for (let m of Mesh.all) out[m.name] = Object.keys(m.faces).length;
	let g = Mesh.all.find(m => m.name == 'group');
	out._selected = Outliner.selected.map(e => e.name);
	if (g) { let ps = Object.values(g.vertices); let axis = i => [Math.min(...ps.map(p => p[i])), Math.max(...ps.map(p => p[i]))];
		out._group = {vertices: ps.length, box: [axis(0), axis(1), axis(2)], on_grid: ps.every(p => p.every(v => Math.abs(v % 16) < 0.001)),
			textured: Object.values(g.faces).filter(f => f.texture).length}; }
	return JSON.stringify(out); })()`;
const tileCount = `(() => { let tiles = DEWTileBrush.buildTileIndex(); let g = Mesh.all.find(m => m.name == 'group');
	let mine = 0; for (let entry of tiles.values()) if (entry.mesh == g) mine++; return mine; })()`;

// A building: walls in one mesh, its floor in another, plus a separate floor that stays behind
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
	// Asymmetric on purpose: 48 across and 32 deep, so a quarter turn is visible in the bounding box
	__build('walls', [['z', 0, 1, 0, 0, 3, 2], ['x', 0, 1, 0, 0, 2, 2]]);   // 6 + 4 faces, the building
	__build('inner_floor', [['y', 0, 1, 0, 0, 3, 2]]);                       // 6 faces, also the building
	__build('ground', [['y', 0, 1, 64, 0, 2, 2]]);                           // 4 faces, stays put
	unselectAllElements(); return true; })()`);
await ev(`(() => { BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(400);
await ev(`(() => { let t = Texture.all[0];
	for (let m of Mesh.all) for (let f of Object.values(m.faces)) { f.texture = t.uuid; f.vertices.forEach(k => f.uv[k] = [0, 0]); }
	return true; })()`);
console.log('start:', await ev(state));
console.log('   move snap in a DEW scene:', await ev(`JSON.stringify({format_step: Format.edit_size, user_setting: settings.edit_size.value, snap: canvasGridSize()})`), ' expect step 1, the setting left at 16, snap 16');

console.log('A. select the building (walls + inner floor):', await ev(`(() => {
	for (let name of ['walls', 'inner_floor']) { let m = Mesh.all.find(m => m.name == name);
		m.getSelectedFaces(true).replace(Object.keys(m.faces));
		m.getSelectedVertices(true).replace(Object.keys(m.vertices));
		if (!m.selected) m.markAsSelected(); }
	updateSelection();
	return JSON.stringify({condition: Condition(BarItems.dew_group_tiles.condition)}); })()`));

await ev(`(() => { BarItems.dew_group_tiles.click(); return true; })()`);
console.log('B. group them:', await ev(state), ' expect group with 16 faces, box x [0,48] y [0,32] z [0,32], sources gone, ground untouched');
console.log('   the tile tools still see its tiles:', await ev(tileCount), ' expect 16');

await ev(`(() => { Undo.undo(); return true; })()`);
console.log('C. undo:', await ev(state), ' expect walls 10, inner_floor 6, no group');
await ev(`(() => { Undo.redo(); return true; })()`);

console.log('D. rotate 90 clockwise:', await ev(`(() => { BarItems.dew_rotate_group_cw.click(); return true; })()`) && await ev(state),
	' expect 16 faces, on_grid true, box now x [0,32] z [0,48], y unchanged, same corner');
console.log('   tiles still recognised:', await ev(tileCount), ' expect 16');
console.log('E. four turns return it:', await ev(`(() => { for (let i = 0; i < 3; i++) BarItems.dew_rotate_group_cw.click(); return true; })()`) && await ev(state),
	' expect box back to x [0,48] z [0,32]');

console.log('F. duplicate and move by a half cell:', await ev(`(() => { let g = Mesh.all.find(m => m.name == 'group');
	let copy = new Mesh(g); copy.name = 'group_copy'; copy.init(); copy.select();
	copy.origin = [0, 0, 0]; for (let vkey in copy.vertices) copy.vertices[vkey][0] += 16;
	Canvas.updateView({elements: [copy], element_aspects: {geometry: true}});
	let ps = Object.values(copy.vertices); return JSON.stringify({faces: Object.keys(copy.faces).length, on_grid: ps.every(p => p.every(v => Math.abs(v % 16) < 0.001))}); })()`));

console.log('G. a generic model snaps its own way:', await ev(`(() => { newProject(Formats.free); return JSON.stringify({format_step: Format.edit_size || null, user_setting: settings.edit_size.value, snap: canvasGridSize()}); })()`), ' expect no step, setting 16, snap 1');
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
