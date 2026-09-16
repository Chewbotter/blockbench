// The status bar's triangle count: selected / scene, cubes at two per drawn face, meshes at n - 2 per face,
// hidden elements and non-exported helpers left out of the scene count.
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

const info = `(() => { updateSelection(); return JSON.stringify({poly: Interface.status_bar.vue.poly_info, shown: !!document.querryselector ? null : [...document.querySelectorAll('#status_bar .status_selection_info')].map(n => n.textContent.trim()).filter(Boolean)}); })()`;
// A DEW scene: the scale figure (not exported) plus two cubes and a mesh of four quads and one triangle
await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove()); Cube.all.filter(c => c.name != DEWScene.DEW.FIGURE_NAME).forEach(c => c.remove()); unselectAllElements();
	new Cube({name: 'a', from: [0, 0, 0], to: [16, 16, 16]}).init();
	new Cube({name: 'b', from: [32, 0, 0], to: [48, 16, 16]}).init();
	let m = new Mesh({name: 'm', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	for (let x = 0; x < 32; x += 16) for (let z = 0; z < 32; z += 16) m.addFaces(new MeshFace(m, {vertices: [[x,0,z+64],[x+16,0,z+64],[x+16,0,z+80],[x,0,z+80]].map(vert)}));
	m.addFaces(new MeshFace(m, {vertices: [[0,0,100],[16,0,100],[0,16,100]].map(vert)}));
	m.init(); updateSelection(); return true; })()`).catch(async err => {
	// DEWScene may not be exposed; fall back to removing meshes only
	await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove()); Cube.all.filter(c => c.name != 'scale_figure').forEach(c => c.remove()); unselectAllElements();
		new Cube({name: 'a', from: [0, 0, 0], to: [16, 16, 16]}).init();
		new Cube({name: 'b', from: [32, 0, 0], to: [48, 16, 16]}).init();
		let m = new Mesh({name: 'm', vertices: {}}); let map = {};
		let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
		for (let x = 0; x < 32; x += 16) for (let z = 0; z < 32; z += 16) m.addFaces(new MeshFace(m, {vertices: [[x,0,z+64],[x+16,0,z+64],[x+16,0,z+80],[x,0,z+80]].map(vert)}));
		m.addFaces(new MeshFace(m, {vertices: [[0,0,100],[16,0,100],[0,16,100]].map(vert)}));
		m.init(); updateSelection(); return true; })()`);
});
await sleep(300);
console.log('A. nothing selected:', await ev(info), ' expect "33 tris": 12 + 12 + 8 + 1, the scale figure left out');
await ev(`(() => { Cube.all.find(c => c.name == 'a').select(); return true; })()`);
console.log('B. one cube selected:', await ev(info), ' expect "12 / 33 tris"');
await ev(`(() => { Mesh.all[0].select(); return true; })()`);
console.log('C. the mesh selected:', await ev(info), ' expect "9 / 33 tris"');
await ev(`(() => { let c = Cube.all.find(c => c.name == 'b'); c.faces.up.texture = null; c.visibility = false; updateSelection(); return true; })()`);
console.log('D. cube b hidden:', await ev(info), ' expect "9 / 21 tris": a hidden element leaves the scene count');
await ev(`(() => { let c = Cube.all.find(c => c.name == 'b'); c.visibility = true; updateSelection(); return true; })()`);
console.log('   shown again with one face disabled:', await ev(info), ' expect "9 / 31 tris"');
console.log('E. status bar shows it:', await ev(`JSON.stringify([...document.querySelectorAll('#status_bar .status_selection_info')].map(n => n.textContent.trim()).filter(Boolean))`), ' expect the tris text among the entries');

console.log('page errors:', errors.length ? errors : 'none');
ws.close();
