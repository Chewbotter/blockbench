// The in-place selection colouring gives the same outline and vertex point colours as the stock code in object,
// face, edge and vertex mode, with partial selections, and is faster on 10k faces.
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

await ev(`(() => { newProject(Formats.free); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove()); let side = 20;
	let m = new Mesh({name: 'grid', vertices: {}}); let keys = [];
	for (let z = 0; z <= side; z++) { keys.push([]); for (let x = 0; x <= side; x++) keys[z].push(m.addVertices([x * 4, 0, z * 4])[0]); }
	let n = 0;
	for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) { let vs = [keys[z][x], keys[z][x + 1], keys[z + 1][x + 1], keys[z + 1][x]]; let uv = {}; vs.forEach(v => uv[v] = [0, 0]);
		if (n++ % 6 == 0) { m.addFaces(new MeshFace(m, {vertices: vs.slice(0, 3), uv, texture: false})); m.addFaces(new MeshFace(m, {vertices: [vs[0], vs[2], vs[3]], uv, texture: false})); }
		else m.addFaces(new MeshFace(m, {vertices: vs, uv, texture: false})); }
	m.init(); m.select(); updateSelection();
	window.__colors = () => { let g = m.mesh; return {outline: Array.from(g.outline.geometry.attributes.color.array), points: g.vertex_points.geometry.attributes.color ? Array.from(g.vertex_points.geometry.attributes.color.array) : [], points_visible: g.vertex_points.visible}; };
	window.__compare = () => { let m = Mesh.all[0]; m.preview_controller.updateSelection(m); let lean = __colors(); DEWPerf.stockUpdateSelection.call(m.preview_controller, m); let stock = __colors();
		let diff = k => { if (lean[k].length != stock[k].length) return k + ' length ' + lean[k].length + ' vs ' + stock[k].length; for (let i = 0; i < lean[k].length; i++) if (Math.abs(lean[k][i] - stock[k][i]) > 1e-6) return k + ' differs at ' + i; return null; };
		let lit = 0; for (let i = 0; i < lean.outline.length; i += 3) if (lean.outline[i] > 0.99 && lean.outline[i + 1] > 0.99 && lean.outline[i + 2] > 0.99) lit++;
		return {outline: diff('outline') || 'same', points: diff('points') || 'same', points_visible_same: lean.points_visible == stock.points_visible, lit_outline_vertices: lit}; };
	return true; })()`);
await sleep(300);
console.log('A. object mode:', await ev(`(() => { BarItems.selection_mode.set('object'); return JSON.stringify(__compare()); })()`), ' expect same, same, no lit (object colour, not white)');
console.log('B. face mode, 37 faces selected:', await ev(`(() => { BarItems.selection_mode.set('face'); let m = Mesh.all[0]; m.getSelectedFaces(true).replace(Object.keys(m.faces).filter((k, i) => i % 11 == 0)); return JSON.stringify(__compare()); })()`), ' expect same, same, some lit');
console.log('C. edge mode, a few edges selected:', await ev(`(() => { BarItems.selection_mode.set('edge'); let m = Mesh.all[0]; let f = Object.values(m.faces); m.getSelectedEdges(true).replace([[f[0].vertices[0], f[0].vertices[1]], [f[5].vertices[2], f[5].vertices[1]], [f[9].vertices[0], f[9].vertices[3] || f[9].vertices[2]]]); return JSON.stringify(__compare()); })()`), ' expect same, same, lit 6 (three edges, two outline vertices each)');
console.log('D. vertex mode, some vertices selected:', await ev(`(() => { BarItems.selection_mode.set('vertex'); let m = Mesh.all[0]; m.getSelectedVertices(true).replace(Object.keys(m.vertices).filter((k, i) => i % 5 == 0)); return JSON.stringify(__compare()); })()`), ' expect same, same, points visible the same');
console.log('E. nothing selected, face mode:', await ev(`(() => { BarItems.selection_mode.set('face'); let m = Mesh.all[0]; m.getSelectedFaces(true).empty(); return JSON.stringify(__compare()); })()`), ' expect same, lit 0');
console.log('F. timing on 10k faces:', await ev(`(() => { newProject(Formats.free); Mesh.all.slice().forEach(m => m.remove()); let side = 100;
	let m = new Mesh({name: 'grid', vertices: {}}); let keys = [];
	for (let z = 0; z <= side; z++) { keys.push([]); for (let x = 0; x <= side; x++) keys[z].push(m.addVertices([x * 4, 0, z * 4])[0]); }
	for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) { let vs = [keys[z][x], keys[z][x + 1], keys[z + 1][x + 1], keys[z + 1][x]]; let uv = {}; vs.forEach(v => uv[v] = [0, 0]); m.addFaces(new MeshFace(m, {vertices: vs, uv, texture: false})); }
	m.init(); m.select(); BarItems.selection_mode.set('object');
	let time = fn => { let best = Infinity; for (let i = 0; i < 3; i++) { let t0 = performance.now(); fn(); best = Math.min(best, performance.now() - t0); } return Math.round(best * 10) / 10; };
	let out = {object_stock: time(() => DEWPerf.stockUpdateSelection.call(m.preview_controller, m)), object_lean: time(() => m.preview_controller.updateSelection(m))};
	BarItems.selection_mode.set('face'); m.getSelectedFaces(true).replace(Object.keys(m.faces));
	out.face_all_stock = time(() => DEWPerf.stockUpdateSelection.call(m.preview_controller, m)); out.face_all_lean = time(() => m.preview_controller.updateSelection(m));
	out.updateSelection_total_object = (BarItems.selection_mode.set('object'), time(() => updateSelection()));
	return JSON.stringify(out); })()`), ' expect lean well under stock in both modes');
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
