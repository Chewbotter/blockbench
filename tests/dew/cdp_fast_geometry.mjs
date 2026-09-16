// The incremental mesh geometry update: a position-only change takes the fast path and the buffers match a full
// rebuild; a topology change, smooth shading or an armature view take the stock path; finished_edit rebuilds.
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

// A 40 x 40 grid of quads plus a few triangles, then a snapshot of every buffer a full rebuild produces
await ev(`(() => { newProject(Formats.free); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove()); let side = 40;
	let m = new Mesh({name: 'grid', vertices: {}}); let keys = [];
	for (let z = 0; z <= side; z++) { keys.push([]); for (let x = 0; x <= side; x++) keys[z].push(m.addVertices([x * 4, Math.sin(x * 0.5) * 3, z * 4])[0]); }
	for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) { let vs = [keys[z][x], keys[z][x + 1], keys[z + 1][x + 1], keys[z + 1][x]]; let uv = {}; vs.forEach(v => uv[v] = [0, 0]);
		if ((x + z) % 7 == 0) { m.addFaces(new MeshFace(m, {vertices: vs.slice(0, 3), uv, texture: false})); m.addFaces(new MeshFace(m, {vertices: [vs[0], vs[2], vs[3]], uv, texture: false})); }
		else m.addFaces(new MeshFace(m, {vertices: vs, uv, texture: false})); }
	m.init(); m.select(); updateSelection();
	window.__snap = () => { let g = m.mesh; return {pos: Array.from(g.geometry.attributes.position.array), nor: Array.from(g.geometry.attributes.normal.array), outline: Array.from(g.outline.geometry.attributes.position.array), points: Array.from(g.vertex_points.geometry.attributes.position.array), index: Array.from(g.geometry.index.array)}; };
	window.__same = (a, b) => { for (let k in a) { if (a[k].length != b[k].length) return k + ' length ' + a[k].length + ' vs ' + b[k].length; for (let i = 0; i < a[k].length; i++) if (Math.abs(a[k][i] - b[k][i]) > 1e-4) return k + ' differs at ' + i + ': ' + a[k][i] + ' vs ' + b[k][i]; } return 'identical'; };
	return true; })()`);
await sleep(300);
const stats = () => ev(`JSON.stringify(DEWPerf.perf_stats)`);
console.log('start:', await ev(`JSON.stringify({faces: Object.keys(Mesh.all[0].faces).length, stats: DEWPerf.perf_stats})`), ' expect a full count from init');

// Move every vertex, update, and compare against what a forced full rebuild gives for the same positions
console.log('A. position-only update:', await ev(`(() => { let m = Mesh.all[0]; let before = JSON.stringify(DEWPerf.perf_stats);
	for (let k in m.vertices) { m.vertices[k][1] += 5; m.vertices[k][0] += 1; }
	let t0 = performance.now(); m.preview_controller.updateGeometry(m); let fast_ms = performance.now() - t0;
	let fast = __snap(); let after_fast = JSON.stringify(DEWPerf.perf_stats);
	// force the stock path for the reference
	m.shading = 'smooth'; m.preview_controller.updateGeometry(m); m.shading = 'flat';
	t0 = performance.now(); m.preview_controller.updateGeometry(m); let full_ms = performance.now() - t0;
	let full = __snap();
	return JSON.stringify({before, after_fast, compare: __same(fast, full), fast_ms: Math.round(fast_ms * 10) / 10, full_ms: Math.round(full_ms)}); })()`));
console.log('   expect the fast counter up by one, compare identical, fast_ms well under full_ms');

console.log('B. topology change takes the stock path:', await ev(`(() => { let m = Mesh.all[0]; let before = DEWPerf.perf_stats.full;
	let keys = Object.keys(m.vertices); m.addFaces(new MeshFace(m, {vertices: [keys[0], keys[1], keys[2]], uv: {}, texture: false}));
	m.preview_controller.updateGeometry(m); let after = DEWPerf.perf_stats.full;
	return JSON.stringify({full_before: before, full_after: after, positions: m.mesh.geometry.attributes.position.count}); })()`), ' expect full up by one and the position count grown by 3');

console.log('C. then a move is fast again:', await ev(`(() => { let m = Mesh.all[0]; let before = DEWPerf.perf_stats.fast; for (let k in m.vertices) m.vertices[k][2] += 2; m.preview_controller.updateGeometry(m);
	let g = m.mesh.geometry.attributes.position.array; let k0 = Object.keys(m.vertices)[0]; let v = m.vertices[k0];
	// the first vertex's first slot holds its new position
	let slot = -1; for (let i = 0; i < g.length / 3; i++) if (Math.abs(g[i*3] - v[0]) < 1e-6 && Math.abs(g[i*3+1] - v[1]) < 1e-6 && Math.abs(g[i*3+2] - v[2]) < 1e-6) { slot = i; break; }
	return JSON.stringify({fast_delta: DEWPerf.perf_stats.fast - before, first_vertex_found_in_buffer: slot >= 0}); })()`), ' expect fast_delta 1, found true');

console.log('D. finished_edit rebuilds what the fast path touched:', await ev(`(() => { let m = Mesh.all[0]; let before = DEWPerf.perf_stats.full; Undo.initEdit({elements: [m]}); for (let k in m.vertices) m.vertices[k][1] -= 1; m.preview_controller.updateGeometry(m); Undo.finishEdit('move'); return JSON.stringify({full_delta: DEWPerf.perf_stats.full - before}); })()`), ' expect 1');

console.log('E. smooth shading takes the stock path:', await ev(`(() => { let m = Mesh.all[0]; m.shading = 'smooth'; let before = DEWPerf.perf_stats.full; m.preview_controller.updateGeometry(m); for (let k in m.vertices) m.vertices[k][1] += 1; m.preview_controller.updateGeometry(m); m.shading = 'flat'; return JSON.stringify({full_delta: DEWPerf.perf_stats.full - before}); })()`), ' expect 2');

// A drag in the real app: the move gizmo on the selected mesh in vertex mode drives updateGeometry per frame
console.log('F. undo after fast path leaves a consistent mesh:', await ev(`(() => { let m = Mesh.all[0]; Undo.undo(); let a = __snap(); caches_probe = 0; m.preview_controller.updateGeometry(m); let b = __snap(); return __same(a, b); })()`), ' expect identical');
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
