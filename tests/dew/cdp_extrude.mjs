// Extrude Tiles: the selected tiles travel along their facing and the sides are skinned with tiles of the
// same size, with nothing left behind where they were.
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

// Faces grouped by the plane they stand in, as plane -> how many, plus any two faces sharing all corners
const shape = `(() => { let r = v => Math.round(v * 100) / 100; let planes = {}, seen = new Map(), doubled = [];
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices(); if (vs.length != 4) continue;
		let n = f.getNormal(true).map(r);
		let axis = Math.abs(n[0]) > 0.99 ? 'x' : Math.abs(n[1]) > 0.99 ? 'y' : Math.abs(n[2]) > 0.99 ? 'z' : null;
		if (!axis) continue;
		let i = {x: 0, y: 1, z: 2}[axis];
		let depth = r(m.vertices[vs[0]][i]);
		let key = axis + ' ' + depth + ' ' + (n[i] > 0 ? '+' : '-');
		planes[key] = (planes[key] || 0) + 1;
		let corners = vs.map(k => m.vertices[k].map(r).join(',')).sort().join(' | ');
		if (seen.has(corners)) doubled.push(corners); else seen.set(corners, fkey); }
	return JSON.stringify({planes, doubled}); })()`;
const untouched = `(() => { let m = Mesh.all[0]; let r = v => Math.round(v * 100) / 100; let out = [];
	for (let fkey in m.faces) { let f = m.faces[fkey]; let vs = f.getSortedVertices();
		if (vs.length != 4 || Math.abs(f.getNormal(true)[1]) < 0.99) continue;
		let ps = vs.map(k => m.vertices[k]);
		if (r(ps[0][1]) != 0) continue;
		out.push(Math.min(...ps.map(p => p[0])) + ',' + Math.min(...ps.map(p => p[2]))); }
	return JSON.stringify(out.sort()); })()`;
const textured = `(() => { let n = 0, plain = 0;
	for (let m of Mesh.all) for (let fkey in m.faces) { let f = m.faces[fkey];
		if (Math.abs(f.getNormal(true)[1]) > 0.99) continue;
		if (f.texture) n++; else plain++; }
	return JSON.stringify({skin_textured: n, skin_plain: plain}); })()`;

// A 3 x 3 floor, with the 2 x 2 corner selected
await ev(`(() => {
	newProject(Formats.dew_scene);
	let m = new Mesh({name: 'floor', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	for (let x = 0; x < 48; x += 16) for (let z = 0; z < 48; z += 16) {
		let pt = (dx, dz) => [x + dx, 0, z + dz];
		let f = new MeshFace(m, {vertices: [pt(0,0), pt(16,0), pt(16,16), pt(0,16)].map(vert), texture: false});
		m.addFaces(f); if (f.getNormal(true)[1] < 0) f.invert(); }
	m.init(); unselectAllElements(); updateSelection(); return Object.keys(m.faces).length; })()`);
await ev(`(() => { BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(400);
await ev(`(() => { let t = Texture.all[0]; let m = Mesh.all[0];
	for (let f of Object.values(m.faces)) { f.texture = t.uuid; f.vertices.forEach(k => f.uv[k] = [0, 0]); }
	Canvas.updateView({elements: [m], element_aspects: {faces: true, uv: true}}); return true; })()`);
const selectCorner = `(() => { let m = Mesh.all[0]; BarItems.selection_mode.set('face'); m.select();
	let picked = Object.keys(m.faces).filter(fkey => { let ps = m.faces[fkey].vertices.map(k => m.vertices[k]);
		return Math.min(...ps.map(p => p[0])) < 32 && Math.min(...ps.map(p => p[2])) < 32; });
	m.getSelectedFaces(true).replace(picked);
	m.getSelectedVertices(true).replace([...new Set(picked.flatMap(fkey => m.faces[fkey].vertices))]);
	updateSelection(); return picked.length; })()`;
console.log('start:', await ev(shape), ' expect 9 tiles on y 0 +');
console.log('selected the 2 x 2 corner:', await ev(selectCorner), ' expect 4');

// Through the menu action and its dialog, at the default of one tile
await ev(`(() => { BarItems.dew_extrude_tiles.click(); return !!Dialog.open; })()`);
await sleep(200);
console.log('A. dialog default:', await ev(`JSON.stringify(Dialog.open.getFormResult())`), ' expect tiles 1');
await ev(`(() => { Dialog.open.confirm(); return true; })()`);
await sleep(300);
console.log('B. after extruding one tile:', await ev(shape));
console.log('   expect y 32 + : 4 (the tiles that travelled), y 0 + : 5 (the ones that stayed),');
console.log('   x 0 - : 4, x 32 + : 4, z 0 - : 4, z 32 + : 4 (the skin, 16 tiles of 16), and doubled empty');
console.log('   the tiles that stayed:', await ev(untouched), ' expect the five outside the corner, still on y 0');
console.log('   skin textures:', await ev(textured), ' expect all textured, none plain');

await ev(`Undo.undo(); true`);
console.log('C. undo:', await ev(shape), ' expect 9 tiles on y 0 + again');

// The other way, half a tile down, straight through the function
console.log('   selected again:', await ev(selectCorner), ' expect 4');
console.log('D. extrude -0.5 tiles:', await ev(`JSON.stringify(DEWGroup.extrudeTiles(-16))`), ' expect 4 moved, 8 skin');
console.log('   planes:', await ev(shape));
console.log('   expect y -16 + : 4, y 0 + : 5, and 2 skin tiles on each of the four sides');
await ev(`Undo.undo(); true`);

// Both entries are on the menus the user reaches
console.log('E. in an element context menu:', await ev(`JSON.stringify(Mesh.prototype.menu.structure.filter(entry => typeof entry == 'string' && entry.startsWith('dew_')))`));
console.log('   expect cull, group and extrude');
console.log('F. right-click with Tile Select:', await ev(`(() => { BarItems.dew_tile_select.select();
	return JSON.stringify({handler: typeof Toolbox.selected.onCanvasRightClick, selects_elements: !!Toolbox.selected.selectElements}); })()`));
console.log('   expect handler function: a tool that does not select elements never reaches an element menu on its own');
console.log('G. extrude is offered only with tiles selected:', await ev(`(() => { let on = Condition(BarItems.dew_extrude_tiles.condition);
	unselectAllElements(); updateSelection();
	return JSON.stringify({with_selection: on, without: Condition(BarItems.dew_extrude_tiles.condition)}); })()`), ' expect true then false');

console.log('page errors:', errors.length ? errors : 'none');
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_extrude.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
