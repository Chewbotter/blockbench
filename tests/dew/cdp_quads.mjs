// Merge Triangles into Quads: coplanar pairs with continuous uvs become quads, a folded pair, a uv seam and a
// texture change stay triangles, normals and uvs survive, and undo puts the triangles back.
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

// A triangulated 2 x 2 floor (8 triangles, continuous planar uvs) plus a folded pair (a 90 degree ridge), a pair with
// a uv seam along the diagonal, and a pair whose second triangle has another texture
await ev(`(() => { newProject(Formats.free); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove());
	let m = new Mesh({name: 'tris', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	let tri = (pts, uvs, texture = false) => { let vs = pts.map(vert); let uv = {}; vs.forEach((v, i) => uv[v] = uvs[i]); let f = new MeshFace(m, {vertices: vs, uv, texture}); m.addFaces(f); return f; };
	for (let x = 0; x < 32; x += 16) for (let z = 0; z < 32; z += 16) {
		tri([[x,0,z],[x+16,0,z],[x+16,0,z+16]], [[x,z],[x+16,z],[x+16,z+16]]);
		tri([[x,0,z],[x+16,0,z+16],[x,0,z+16]], [[x,z],[x+16,z+16],[x,z+16]]);
	}
	// folded: shares the edge (64,0,0)-(64,0,16), second triangle stands up
	tri([[48,0,0],[64,0,0],[64,0,16]], [[0,0],[16,0],[16,16]]);
	tri([[64,0,0],[64,16,16],[64,0,16]], [[16,0],[32,16],[16,16]]);
	// uv seam: same plane, the shared edge reads different texels from each side
	tri([[96,0,0],[112,0,0],[112,0,16]], [[0,0],[16,0],[16,16]]);
	tri([[96,0,0],[112,0,16],[96,0,16]], [[40,0],[56,16],[40,16]]);
	// texture change
	tri([[128,0,0],[144,0,0],[144,0,16]], [[0,0],[16,0],[16,16]]);
	tri([[128,0,0],[144,0,16],[128,0,16]], [[0,0],[16,16],[0,16]], 'some-other-uuid');
	m.init(); m.select(); updateSelection(); return true; })()`);
await sleep(300);
const shape = `(() => { let m = Mesh.all[0]; let faces = Object.values(m.faces); let quads = faces.filter(f => f.vertices.length == 4), tris = faces.filter(f => f.vertices.length == 3);
	let up = quads.every(f => f.getNormal(true)[1] < -0.99);	// the source triangles face -y, and the quads keep that
	let uv_ok = quads.every(f => f.vertices.every(v => { let p = m.vertices[v]; let uv = f.uv[v]; return uv && uv[0] == p[0] && uv[1] == p[2]; }));
	return JSON.stringify({quads: quads.length, tris: tris.length, quads_keep_normal: up, quad_uvs_match_position: uv_ok, status: Interface.status_bar.vue.poly_info}); })()`;
console.log('start:', await ev(shape), ' expect 0 quads, 14 tris');
console.log('A. merge:', await ev(`JSON.stringify(DEWQuads.mergeTrianglesToQuads())`), ' expect merged 4, left 6');
console.log('   result:', await ev(shape), ' expect 4 quads keeping the triangles normal, uvs intact, 6 tris (folded, seam, texture pairs), status 14 tris either way');
console.log('   undo:', await ev(`(() => { Undo.undo(); return JSON.stringify({faces: Object.keys(Mesh.all[0].faces).length, action: Undo.history.at(Undo.index)?.action}); })()`), ' expect 14 faces back');
await ev(`Undo.redo(); true`);
console.log('B. run again on the result:', await ev(`JSON.stringify(DEWQuads.mergeTrianglesToQuads())`), ' expect merged 0, left 6, no undo entry added');
console.log('   action offered:', await ev(`JSON.stringify({offered: Condition(BarItems.dew_merge_triangles.condition), in_menu: MenuBar.menus.mesh.structure.includes('dew_merge_triangles')})`), ' expect both true');
// An import with split vertices: every triangle owns its own copies, as a glTF importer leaves them
await ev(`(() => { Mesh.all.slice().forEach(m => m.remove());
	let m = new Mesh({name: 'split', vertices: {}});
	let tri = (pts, uvs) => { let vs = pts.map(p => m.addVertices(p)[0]); let uv = {}; vs.forEach((v, i) => uv[v] = uvs[i]); m.addFaces(new MeshFace(m, {vertices: vs, uv, texture: false})); };
	for (let x = 0; x < 32; x += 16) { tri([[x,0,0],[x+16,0,0],[x+16,0,16]], [[x,0],[x+16,0],[x+16,16]]); tri([[x,0,0],[x+16,0,16],[x,0,16]], [[x,0],[x+16,16],[x,16]]); }
	m.init(); m.select(); updateSelection(); return JSON.stringify({vertices: Object.keys(m.vertices).length, faces: Object.keys(m.faces).length}); })()`).then(v => console.log('C. split mesh:', v, ' expect 12 vertices for 4 faces'));
console.log('   merge welds first:', await ev(`JSON.stringify(DEWQuads.mergeTrianglesToQuads())`), ' expect welded 6, merged 2, left 0');
console.log('   result:', await ev(`(() => { let m = Mesh.all[0]; return JSON.stringify({vertices: Object.keys(m.vertices).length, quads: Object.values(m.faces).filter(f => f.vertices.length == 4).length, shared: Object.values(m.faces).every(f => f.vertices.every(v => m.vertices[v]))}); })()`), ' expect 6 vertices, 2 quads, every face on live vertices');
console.log('D. a lone folded pair reports why:', await ev(`(() => { Mesh.all.slice().forEach(m => m.remove()); let m = new Mesh({name: 'fold', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	let tri = pts => { let vs = pts.map(vert); let uv = {}; vs.forEach(v => uv[v] = [0, 0]); m.addFaces(new MeshFace(m, {vertices: vs, uv, texture: false})); };
	tri([[0,0,0],[16,0,0],[16,0,16]]); tri([[16,0,0],[16,16,16],[16,0,16]]);
	m.init(); m.select(); return JSON.stringify(DEWQuads.mergeTrianglesToQuads()); })()`), ' expect merged 0, welded 0, why shared_edges 1 angle 1');

console.log('page errors:', errors.length ? errors : 'none');
ws.close();
