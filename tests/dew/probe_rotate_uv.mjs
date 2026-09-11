// Rotating a group turns its vertices; the UVs ride along. This shows what that does to a wall tile and a floor
// tile, comparing each face's UVs after the turn against what the texture brush's convention would give for its
// new facing. Equal means a re-derive would change nothing; different means the art follows the building instead.
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

// Every tile face: its plane, its UVs, and the UVs the brush convention would write for that facing now
const compare = `(() => { let m = Mesh.all.find(m => m.name == 'group') || Mesh.all[0]; let r = v => Math.round(v * 100) / 100;
	let out = [];
	for (let fkey in m.faces) { let f = m.faces[fkey];
		let tile = DEWTileBrush.describeTile(m, f); if (!tile) continue;
		let [ua, va] = DEWTileBrush.PLANE_AXES[tile.axis];
		// The convention gives offsets inside the cell, so compare against the face's own cell origin
		let uvs = f.vertices.map(vkey => f.uv[vkey]);
		let cell = [Math.min(...uvs.map(uv => uv[0])), Math.min(...uvs.map(uv => uv[1]))];
		let rows = f.vertices.map(vkey => { let p = m.vertices[vkey];
			let want = DEWTileBrush.tileUV(tile.axis, tile.sign, Math.round(p[{x: 0, y: 1, z: 2}[ua]] - tile.u), Math.round(p[{x: 0, y: 1, z: 2}[va]] - tile.v), 16);
			return {at: p.join(','), uv: f.uv[vkey].map(r).join(','), convention: [cell[0] + want[0], cell[1] + want[1]].map(r).join(',')}; });
		out.push({plane: tile.axis + ' ' + tile.depth + ' facing ' + tile.sign, matches: rows.every(row => row.uv == row.convention), rows}); }
	return JSON.stringify(out, null, 1); })()`;

// One +z wall tile and one floor tile, both painted by the convention for their starting facing
await ev(`(() => {
	newProject(Formats.dew_scene);
	let m = new Mesh({name: 'group', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	let wall = new MeshFace(m, {vertices: [[0,0,0],[16,0,0],[16,16,0],[0,16,0]].map(vert), texture: false});
	let floor = new MeshFace(m, {vertices: [[0,0,0],[16,0,0],[16,0,16],[0,0,16]].map(vert), texture: false});
	m.addFaces(wall); m.addFaces(floor);
	if (wall.getNormal(true)[2] < 0) wall.invert();
	if (floor.getNormal(true)[1] < 0) floor.invert();
	m.init();
	return true; })()`);
await ev(`(() => { BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(400);
// Paint both by the convention, from atlas cell (16, 0)
await ev(`(() => { let t = Texture.all[0]; let m = Mesh.all[0];
	for (let fkey in m.faces) { let f = m.faces[fkey]; let tile = DEWTileBrush.describeTile(m, f); f.texture = t.uuid;
		let [ua, va] = DEWTileBrush.PLANE_AXES[tile.axis]; let axis_index = {x: 0, y: 1, z: 2};
		f.vertices.forEach(vkey => { let p = m.vertices[vkey];
			let uv = DEWTileBrush.tileUV(tile.axis, tile.sign, p[axis_index[ua]] - tile.u, p[axis_index[va]] - tile.v, 16);
			f.uv[vkey] = [16 + uv[0], uv[1]]; }); }
	Canvas.updateView({elements: [m], element_aspects: {faces: true, uv: true}}); return true; })()`);
console.log('before the turn (painted by the convention, so everything matches):');
console.log(await ev(compare));

await ev(`(() => { unselectAllElements(); Mesh.all[0].select(); BarItems.dew_rotate_group_cw.click(); return true; })()`);
console.log('\nafter a quarter turn clockwise:');
console.log(await ev(compare));
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
