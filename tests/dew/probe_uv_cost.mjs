// Is the UV editor the thing that gets slow when a lot of tiles are highlighted?
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

await ev(`(() => {
	window.__mesh = side => { newProject(Formats.dew_scene);
		let m = new Mesh({name: 'floor', vertices: {}}); let map = {};
		let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
		for (let x = 0; x < side * 16; x += 16) for (let z = 0; z < side * 16; z += 16) {
			let pt = (dx, dz) => [x + dx, 0, z + dz];
			let f = new MeshFace(m, {vertices: [pt(0,0), pt(16,0), pt(16,16), pt(0,16)].map(vert), texture: false});
			m.addFaces(f); if (f.getNormal(true)[1] < 0) f.invert(); }
		m.init(); let p = Preview.selected; let c = side * 8;
		p.controls.target.set(c, 0, c); p.camera.position.set(c, side * 14, side * 24); p.controls.update();
		unselectAllElements(); updateSelection(); return Object.keys(m.faces).length; };
	window.__timeSel = n => { let t0 = performance.now(); for (let i = 0; i < n; i++) updateSelection(); return Math.round((performance.now() - t0) / n); };
	window.__uvNodes = () => UVEditor.vue && UVEditor.vue.$el ? UVEditor.vue.$el.querySelectorAll('*').length : -1;
	window.__timeUV = async n => { let t0 = performance.now();
		for (let i = 0; i < n; i++) { UVEditor.vue.$forceUpdate(); await UVEditor.vue.$nextTick(); }
		return Math.round((performance.now() - t0) / n); };
	return true; })()`);

console.log('faces:', await ev(`__mesh(80)`));
await sleep(700);
console.log('nothing selected:            updateSelection', await ev('__timeSel(3)'), 'ms, uv redraw', await ev('__timeUV(3)'), 'ms, uv dom nodes', await ev('__uvNodes()'));

await ev(`(() => { BarItems.dew_tile_brush.select(); return true; })()`);
await sleep(400);
await ev(`(() => { BarItems.selection_mode.set('object'); Mesh.all[0].select(); updateSelection(); return true; })()`);
await sleep(700);
console.log('mesh selected, object mode:  updateSelection', await ev('__timeSel(3)'), 'ms, uv redraw', await ev('__timeUV(3)'), 'ms, uv dom nodes', await ev('__uvNodes()'));

await ev(`(() => { let m = Mesh.all[0]; BarItems.selection_mode.set('face');
	m.getSelectedFaces(true).replace(Object.keys(m.faces)); m.getSelectedVertices(true).replace(Object.keys(m.vertices));
	updateSelection(); return true; })()`);
await sleep(900);
console.log('every face highlighted:      updateSelection', await ev('__timeSel(3)'), 'ms, uv redraw', await ev('__timeUV(3)'), 'ms, uv dom nodes', await ev('__uvNodes()'));

// The UV editor showing nothing, with the same selection
await ev(`(() => { UVEditor.vue.display_uv = 'selected_faces'; UVEditor.vue.$forceUpdate(); return UVEditor.vue.display_uv; })()`);
await sleep(700);
console.log('same, display_uv selected_faces:', await ev('__timeSel(3)'), 'ms, uv redraw', await ev('__timeUV(3)'), 'ms, uv dom nodes', await ev('__uvNodes()'));

console.log('display_uv options:', await ev(`JSON.stringify(Object.keys(UVEditor.vue.$options.props || {}).slice(0, 5))`), await ev(`JSON.stringify(settings.show_only_selected_uv ? 'setting exists' : 'no setting')`));
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
