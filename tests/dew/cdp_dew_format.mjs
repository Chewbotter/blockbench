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

const gridInfo = `(() => three_grid.children.map(c => c.name + ':' + (c.geometry?.attributes?.position?.count ?? '-')).join(' '))()`;

console.log('A. format:', await ev(`JSON.stringify({exists: !!Formats.dew_scene, name: Formats.dew_scene?.name, category: Formats.dew_scene?.category, on_start: Formats.dew_scene?.show_on_start_screen, has_grid_hook: typeof Formats.dew_scene?.buildGrid, free_has_hook: typeof Formats.free.buildGrid})`));

console.log('B. new DEW project:', await ev(`(() => { newProject(Formats.dew_scene);
	let p = Preview.selected;
	return JSON.stringify({format: Format.id, export_options: Project.export_options.gltf, target: p.controls.target.toArray(), camera: p.camera.position.toArray().map(v => Math.round(v)), side_grids: !!Canvas.side_grids?.x}); })()`));
console.log('   grid children:', await ev(gridInfo));
// expected: 21 bold lines per direction (0..320 step 32 -> 11? no: 0..320 step 16 = 21 values, 11 bold + 10 thin) -> bold 11*2 lines*2 verts = 44, thin 10*2*2 = 40
console.log('   expected: thin 40 verts, bold 44 verts, storeys 3*8 + 4*2 = 32 verts, axis 2 + 2');

await sleep(600);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_dew_grid.png', Buffer.from(shot.result.data, 'base64'));

console.log('C. 16-unit cube export:', await ev(`(async () => {
	let m = new Mesh({name: 'cube16', vertices: {}});
	let P = [[0,0,0],[16,0,0],[16,16,0],[0,16,0],[0,0,16],[16,0,16],[16,16,16],[0,16,16]]; let k = P.map(p => m.addVertices(p)[0]);
	[[k[0],k[1],k[5],k[4]], [k[3],k[7],k[6],k[2]], [k[0],k[3],k[2],k[1]], [k[4],k[5],k[6],k[7]], [k[0],k[4],k[7],k[3]], [k[1],k[2],k[6],k[5]]].forEach(q => m.addFaces(new MeshFace(m, {vertices: q})));
	m.init();
	let buf = await Codecs.gltf.compile();
	let dv = new DataView(buf);
	let magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
	let json_len = dv.getUint32(12, true);
	let json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, json_len)));
	let acc = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
	let node = json.nodes.find(n => n.mesh !== undefined);
	return JSON.stringify({is_arraybuffer: buf instanceof ArrayBuffer, magic, pos_min: acc.min, pos_max: acc.max, node_name: node.name, node_translation: node.translation || null,
		double_sided: (json.materials || []).map(m => !!m.doubleSided)});
})()`));
console.log('   expect double_sided [true]: the viewport culls back faces, the glb keeps them, which is what the game reads');

console.log('D. save keeps options:', await ev(`(() => { let model = JSON.parse(Codecs.project.compile()); return JSON.stringify({model_format: model.meta.model_format, export_options: model.export_options}); })()`));

console.log('E. generic model untouched:', await ev(`(() => { newProject(Formats.free);
	return JSON.stringify({format: Format.id, export_options: Project.export_options.gltf || null, dialog_scale: Codecs.gltf.getExportOptions().scale, global_scale: Settings.get('model_export_scale')}); })()`));
console.log('   grid children:', await ev(gridInfo));

console.log('F. back to DEW tab:', await ev(`(() => { let dew = ModelProject.all.find(p => p.format.id == 'dew_scene'); dew.select(); return Format.id; })()`));
console.log('   grid children:', await ev(gridInfo));

console.log('page errors:', errors.length ? errors : 'none');
ws.close();
