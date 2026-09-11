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

const state = `(() => { let out = {}; for (let m of Mesh.all) { let ps = [];
	for (let fkey in m.faces) { let t = DEWTileBrush.describeTile(m, m.faces[fkey]); ps.push(t ? [t.axis, t.depth, t.u, t.v].join(' ') : 'other'); }
	out[m.name] = {faces: Object.keys(m.faces).length, tiles: ps.sort()}; }
	return JSON.stringify(out); })()`;
const counts = `(() => { let out = {}; for (let m of Mesh.all) out[m.name] = Object.keys(m.faces).length; return JSON.stringify(out); })()`;

// ground: 4 x 4 floor tiles. group: a 2 x 2 floor patch sitting on the same cells, plus a wall tile that overlaps nothing.
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
	__build('ground', [['y', 0, 1, 0, 0, 4, 4]]);
	__build('group', [['y', 0, 1, 0, 0, 2, 2], ['z', 0, 1, 64, 0, 1, 1]]);
	__build('far', [['y', 0, 1, 128, 0, 2, 2]]);
	unselectAllElements(); return true; })()`);
console.log('start:', await ev(counts), ' expect ground 16, group 5, far 4');

console.log('A. cull from the group:', await ev(`(() => { let g = Mesh.all.find(m => m.name == 'group'); BarItems.dew_cull_overlapping.click(g); return true; })()`) && await ev(counts),
	' expect both sides cleared: ground 12, group 1 (only its wall tile), far 4');
console.log('   what is left:', await ev(state));

console.log('B. undo:', await ev(`(() => { Undo.undo(); return true; })()`) && await ev(counts), ' expect ground 16 again');

console.log('C. nothing overlapping the far patch:', await ev(`(() => { let f = Mesh.all.find(m => m.name == 'far'); BarItems.dew_cull_overlapping.click(f); return true; })()`) && await ev(counts),
	' expect no change');

console.log('D. an element left with nothing is removed:', await ev(`(() => { let g = Mesh.all.find(m => m.name == 'group');
	let cover = __build('cover', [['y', 0, 1, 0, 0, 2, 2]]); unselectAllElements();
	BarItems.dew_cull_overlapping.click(g);
	return JSON.stringify({cover_gone: !Mesh.all.find(m => m.name == 'cover')}); })()`), ' expect cover_gone true: its four tiles all coincided');
console.log('   ', await ev(counts));

console.log('E. in the menu and only in DEW scenes:', await ev(`JSON.stringify({in_mesh_menu: Mesh.prototype.menu.structure.includes('dew_cull_overlapping'), dew: Condition(BarItems.dew_cull_overlapping.condition)})`),
	await ev(`(() => { newProject(Formats.free); return JSON.stringify({generic: Condition(BarItems.dew_cull_overlapping.condition)}); })()`));
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
