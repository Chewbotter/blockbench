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

const figure = `(() => { let c = Cube.all.find(c => c.name == DEW.FIGURE_NAME); if (!c) return 'none';
	return JSON.stringify({from: c.from, to: c.to, size: [c.to[0] - c.from[0], c.to[1] - c.from[1], c.to[2] - c.from[2]],
		exports: c.export, visible: c.visibility, locked: c.locked}); })()`;

console.log('A. new DEW scene:', await ev(`(() => { newProject(Formats.dew_scene); return true; })()`) && await ev(figure), ' expect 32 x 48 x 32, export false');
console.log('   toggle exists and is on:', await ev(`JSON.stringify({exists: !!BarItems.dew_scale_figure, on: BarItems.dew_scale_figure.value, in_view_menu: MenuBar.menus.view.structure.includes('dew_scale_figure')})`));

console.log('B. toggle off:', await ev(`(() => { BarItems.dew_scale_figure.click(); return true; })()`) && await ev(figure), ' expect visible false');
console.log('   toggle on:', await ev(`(() => { BarItems.dew_scale_figure.click(); return true; })()`) && await ev(figure), ' expect visible true');

console.log('C. deleted, then toggled back:', await ev(`(() => { Cube.all.find(c => c.name == DEW.FIGURE_NAME).remove(); return Cube.all.length; })()`),
	await ev(`(() => { BarItems.dew_scale_figure.click(); BarItems.dew_scale_figure.click(); return true; })()`) && await ev(figure), ' expect it comes back');

console.log('D. the tile tools ignore it:', await ev(`(() => {
	let c = Cube.all.find(c => c.name == DEW.FIGURE_NAME);
	let m = new Mesh({name: 'floor', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	for (let x = c.from[0]; x < c.to[0]; x += 16) for (let z = c.from[2]; z < c.to[2]; z += 16) {
		let f = new MeshFace(m, {vertices: [[x,0,z],[x+16,0,z],[x+16,0,z+16],[x,0,z+16]].map(vert), texture: false});
		m.addFaces(f); if (f.getNormal(true)[1] < 0) f.invert(); }
	m.init(); unselectAllElements();
	let p = Preview.selected; let center = [(c.from[0] + c.to[0]) / 2, c.to[1] + 8, (c.from[2] + c.to[2]) / 2];
	p.controls.target.set(center[0], 0, center[2]); p.camera.position.set(center[0] + 120, 160, center[2] + 160); p.controls.update();
	return new Promise(done => setTimeout(() => {
		let v = new THREE.Vector3(center[0], c.to[1] - 8, center[2]).project(p.camera); let r = p.canvas.getBoundingClientRect();
		let e = {clientX: r.left + (v.x + 1) / 2 * r.width, clientY: r.top + (1 - v.y) / 2 * r.height, target: p.canvas};
		let hit = DEWTileBrush.hitFace(p, e);
		done(JSON.stringify({aimed_at: 'the figure', hit: hit ? hit.element.name : null}));
	}, 200)); })()`), ' expect the floor behind it, or null, never the figure');

console.log('E. export leaves it out:', await ev(`(async () => { let buf = await Codecs.gltf.compile(); let dv = new DataView(buf);
	let json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, dv.getUint32(12, true))));
	return JSON.stringify({nodes: (json.nodes || []).map(n => n.name)}); })()`), ' expect floor only, no figure');

console.log('F. generic model:', await ev(`(() => { newProject(Formats.free); return JSON.stringify({figures: Cube.all.filter(c => c.name == DEW.FIGURE_NAME).length, toggle: Condition(BarItems.dew_scale_figure.condition)}); })()`), ' expect none, condition false');
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
