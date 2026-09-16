// The lean MeshFace undo copy holds exactly what the stock one held, on a mesh with textures, triangles, quads,
// smoothing groups and a missing uv; an edit undoes and redoes to identical geometry; and it is faster.
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

await ev(`(() => { newProject(Formats.free); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove());
	BarItems.create_dew_atlas && 0; let tex = new Texture({name: 'tex'}).fromDataURL(document.createElement('canvas').toDataURL()).add(false);
	let m = new Mesh({name: 'varied', vertices: {}}); let keys = [];
	for (let z = 0; z <= 30; z++) { keys.push([]); for (let x = 0; x <= 30; x++) keys[z].push(m.addVertices([x * 4, Math.sin(x) * 3, z * 4])[0]); }
	let n = 0;
	for (let z = 0; z < 30; z++) for (let x = 0; x < 30; x++) { let vs = [keys[z][x], keys[z][x + 1], keys[z + 1][x + 1], keys[z + 1][x]]; let uv = {}; vs.forEach((v, i) => uv[v] = [x * 3 + i, z * 2]);
		let texture = n % 3 == 0 ? tex.uuid : (n % 3 == 1 ? false : null);
		if (n % 5 == 0) { let f = new MeshFace(m, {vertices: vs.slice(0, 3), uv, texture}); f.smoothing_group = 2; m.addFaces(f); }
		else { let f = new MeshFace(m, {vertices: vs, uv, texture}); if (n % 7 == 0) f.smoothing_group = 1; m.addFaces(f); }
		n++; }
	let first = Object.values(m.faces)[0]; delete first.uv[first.vertices[0]];	// a face with a missing uv entry
	m.init(); m.select(); updateSelection(); return true; })()`);
await sleep(300);
await ev(`window.__canon = v => Array.isArray(v) ? '[' + v.map(__canon).join(',') + ']' : (v && typeof v == 'object') ? '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + __canon(v[k])).join(',') + '}' : JSON.stringify(v); true`);
console.log('A. copies identical across every face:', await ev(`(() => { let m = Mesh.all[0]; let differ = []; let n = 0;
	for (let k in m.faces) { let f = m.faces[k]; let lean = f.getUndoCopy(); let stock = DEWPerf.stockFaceUndoCopy.call(f);
		let a = __canon(lean), b = __canon(stock);
		let keys_a = Object.keys(lean).filter(k => lean[k] !== undefined).sort().join(','), keys_b = Object.keys(stock).filter(k => stock[k] !== undefined).sort().join(',');
		if (a != b || keys_a != keys_b) differ.push({k, lean, stock}); n++; }
	return JSON.stringify({faces: n, differing: differ.length, sample: differ[0] || null, lean_keys: Object.keys(Object.values(m.faces)[0].getUndoCopy()).sort(), uv_is_copy: Object.values(m.faces)[1].getUndoCopy().uv[Object.values(m.faces)[1].vertices[0]] !== Object.values(m.faces)[1].uv[Object.values(m.faces)[1].vertices[0]]}); })()`));
console.log('   expect 900 faces, differing 0, keys smoothing_group, texture, uv, vertices, uv_is_copy true');

console.log('B. edit, undo, redo round trip:', await ev(`(() => { let m = Mesh.all[0];
	let snap = () => __canon({v: m.vertices, f: Object.fromEntries(Object.entries(m.faces).map(([k, f]) => [k, f.getUndoCopy()]))});
	let before = snap();
	Undo.initEdit({elements: [m]}); for (let k in m.vertices) m.vertices[k][1] += 3; let f0 = Object.values(m.faces)[3]; f0.texture = false; f0.uv[f0.vertices[0]] = [99, 99]; delete m.faces[Object.keys(m.faces)[4]]; Undo.finishEdit('probe');
	let after = snap(); Undo.undo(); let undone = snap(); Undo.redo(); let redone = snap();
	return JSON.stringify({undo_matches_before: undone == before, redo_matches_after: redone == after, faces_after: Object.keys(m.faces).length}); })()`), ' expect both true, 899 faces');

console.log('C. timing on 10k faces:', await ev(`(() => { newProject(Formats.free); Mesh.all.slice().forEach(m => m.remove()); let side = 100;
	let m = new Mesh({name: 'grid', vertices: {}}); let keys = [];
	for (let z = 0; z <= side; z++) { keys.push([]); for (let x = 0; x <= side; x++) keys[z].push(m.addVertices([x * 4, 0, z * 4])[0]); }
	for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) { let vs = [keys[z][x], keys[z][x + 1], keys[z + 1][x + 1], keys[z + 1][x]]; let uv = {}; vs.forEach(v => uv[v] = [0, 0]); m.addFaces(new MeshFace(m, {vertices: vs, uv, texture: false})); }
	m.init(); m.select();
	let t0 = performance.now(); for (let k in m.faces) DEWPerf.stockFaceUndoCopy.call(m.faces[k]); let stock = performance.now() - t0;
	t0 = performance.now(); for (let k in m.faces) m.faces[k].getUndoCopy(); let lean = performance.now() - t0;
	t0 = performance.now(); Undo.initEdit({elements: [m]}); Undo.finishEdit('probe'); let entry = performance.now() - t0;
	return JSON.stringify({stock_ms: Math.round(stock), lean_ms: Math.round(lean), undo_entry_ms: Math.round(entry)}); })()`), ' expect lean well under stock, the entry well under the 94 ms it was');
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
