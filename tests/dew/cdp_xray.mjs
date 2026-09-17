// View > X-Ray (Alt + X): elements draw see-through, a vertex hidden behind the front faces can be clicked in vertex
// mode, and turning it off puts every material back.
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
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); if (!ok) failures++; };

// A generic project: a 16 mesh cube with a small marker cube inside it, camera off the diagonal
await ev(`(() => {
	if (BarItems.dew_xray.value) BarItems.dew_xray.trigger();
	newProject(Formats.free);
	let m = new Mesh({name: 'box', vertices: {}});
	let v = {};
	for (let x of [0, 16]) for (let y of [0, 16]) for (let z of [0, 16]) v[[x, y, z]] = m.addVertices([x, y, z])[0];
	let q = (a, b, c, d) => new MeshFace(m, {vertices: [v[a], v[b], v[c], v[d]]});
	m.addFaces(
		q([0,0,0],[16,0,0],[16,0,16],[0,0,16]), q([0,16,0],[0,16,16],[16,16,16],[16,16,0]),
		q([0,0,0],[0,0,16],[0,16,16],[0,16,0]), q([16,0,0],[16,16,0],[16,16,16],[16,0,16]),
		q([0,0,0],[0,16,0],[16,16,0],[16,0,0]), q([0,0,16],[16,0,16],[16,16,16],[0,16,16])
	);
	m.init();
	let inner = new Cube({name: 'inner', from: [6, 6, 6], to: [10, 10, 10], color: 1}).init();
	Canvas.updateAll();
	let p = Preview.selected;
	p.camera.position.set(40, 30, 60); p.controls.target.set(8, 8, 8); p.camera.lookAt(8, 8, 8); p.controls.update(); p.render();
	return true;
})()`);
await sleep(200);

// Renders to a target and returns the centre pixel of the box
const pixel = `(() => {
	let p = Preview.selected, r = p.renderer;
	let w = 64, h = 64;
	let rt = new THREE.WebGLRenderTarget(w, h);
	p.camera.updateMatrixWorld();
	let c = new THREE.Vector3(8, 8, 8).project(p.camera);
	let x = Math.round((c.x + 1) / 2 * (w - 1)), y = Math.round((c.y + 1) / 2 * (h - 1));
	let aspect = p.camera.aspect; p.camera.aspect = 1; p.camera.updateProjectionMatrix();
	c = new THREE.Vector3(8, 8, 8).project(p.camera);
	x = Math.round((c.x + 1) / 2 * (w - 1)); y = Math.round((c.y + 1) / 2 * (h - 1));
	r.setRenderTarget(rt); r.render(Canvas.scene, p.camera);
	let buf = new Uint8Array(4); r.readRenderTargetPixels(rt, x, y, 1, 1, buf);
	r.setRenderTarget(null); rt.dispose();
	p.camera.aspect = aspect; p.camera.updateProjectionMatrix();
	return Array.from(buf);
})()`;
const setInner = vis => ev(`(() => { let c = Cube.all.find(c => c.name == 'inner'); c.visibility = ${vis}; Canvas.updateVisibility(); return true; })()`);

await setInner(true);
const off_with = await ev(pixel);
await setInner(false);
const off_without = await ev(pixel);
check('A. X-Ray off: the inner cube is hidden by the box', JSON.stringify(off_with) == JSON.stringify(off_without), {with: off_with, without: off_without});

await ev(`(() => { BarItems.dew_xray.trigger(); return true; })()`);
check('B. toggle on sets the shared opacity', await ev(`Canvas.xray && Canvas.backfaceUniforms.XRAY_OPACITY.value == DEWXRay.XRAY.OPACITY`) === true);
await setInner(true);
const on_with = await ev(pixel);
await setInner(false);
const on_without = await ev(pixel);
check('C. X-Ray on: the inner cube shows through the box', JSON.stringify(on_with) != JSON.stringify(on_without), {with: on_with, without: on_without});
await setInner(true);
check('   element materials drop depth writes', await ev(`(() => { let mats = [Mesh.all[0].mesh.material, Cube.all[0].mesh.material].flat(); return mats.every(m => m.transparent && !m.depthWrite); })()`) === true);

// Click-through: in vertex mode the far corner (0, 0, 0) sits behind the front faces
const clickFar = `(() => {
	let m = Mesh.all[0];
	Modes.options.edit.select();
	m.select();
	BarItems.selection_mode.set('vertex'); BarItems.selection_mode.onChange(BarItems.selection_mode); updateSelection();
	let p = Preview.selected; p.render(); p.camera.updateMatrixWorld();
	let far = Object.keys(m.vertices).find(k => m.vertices[k].join() == '0,0,0');
	let s = new THREE.Vector3(0, 0, 0).project(p.camera);
	let rect = p.canvas.getBoundingClientRect();
	let event = {clientX: rect.left + (s.x + 1) / 2 * p.width, clientY: rect.top + (1 - s.y) / 2 * p.height};
	let hit = p.raycast(event);
	return {type: hit && hit.type, vertex: hit && hit.vertex, far};
})()`;
const on_click = await ev(clickFar);
check('D. X-Ray on: a click at the hidden far corner selects that vertex', on_click.type == 'vertex' && on_click.vertex == on_click.far, on_click);

await ev(`(() => { BarItems.dew_xray.trigger(); return true; })()`);
const off_click = await ev(clickFar);
check('E. X-Ray off: the same click stops at the front face', !(off_click.type == 'vertex' && off_click.vertex == off_click.far), off_click);
check('F. toggle off restores opacity and materials', await ev(`(() => {
	let mats = [Mesh.all[0].mesh.material, Cube.all[0].mesh.material].flat();
	return !Canvas.xray && Canvas.backfaceUniforms.XRAY_OPACITY.value == 1 && mats.every(m => m.depthWrite && m.transparent == m.userData.xray_stock.transparent);
})()`) === true);
// Compared in the same state: step D left the box selected in vertex mode, which draws its own points
await setInner(true);
const back_with = await ev(pixel);
await setInner(false);
const back_without = await ev(pixel);
check('   and the inner cube is hidden again', JSON.stringify(back_with) == JSON.stringify(back_without), {with: back_with, without: back_without});

check('G. keybind is Alt + X', await ev(`(() => { let k = BarItems.dew_xray.keybind; return k.key == 88 && k.alt && !k.ctrl && !k.shift; })()`) === true, await ev(`BarItems.dew_xray.keybind.getText()`));
check('   in the View menu', await ev(`JSON.stringify(MenuBar.menus.view.structure).includes('dew_xray')`) === true);

console.log('page errors:', errors.length ? errors : 'none');
console.log(failures ? `${failures} FAILED` : 'all passed');
ws.close();
