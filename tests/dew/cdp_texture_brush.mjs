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

const screen = async (x, y, z) => JSON.parse(await ev(`(() => { let p = Preview.selected; let v = new THREE.Vector3(${x}, ${y}, ${z}).project(p.camera); let r = p.canvas.getBoundingClientRect(); return JSON.stringify([r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]); })()`));
const mouse = (type, [x, y], extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
async function clickAt(at) {
	await mouse('mouseMoved', at, { button: 'none' }); await sleep(50);
	await mouse('mousePressed', at, { buttons: 1 }); await sleep(50);
	await mouse('mouseReleased', at); await sleep(100);
}
const click = async world => clickAt(await screen(...world));
async function drag(from, to, steps = 14) {
	const a = await screen(...from), b = await screen(...to);
	await mouse('mouseMoved', a, { button: 'none' }); await sleep(30);
	await mouse('mousePressed', a, { buttons: 1 }); await sleep(30);
	for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps], { buttons: 1 }); await sleep(25); }
	await mouse('mouseReleased', b); await sleep(100);
}
async function key(letter) {
	const code = letter.toUpperCase().charCodeAt(0);
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await sleep(80);
}
// Client position of a texel center in the UV editor frame
const texel = async (x, y) => JSON.parse(await ev(`(() => { let f = UVEditor.vue.$refs.frame; let r = f.getBoundingClientRect(); let t = UVEditor.vue.texture; return JSON.stringify([r.left + (${x} + 0.5) / t.width * r.width, r.top + (${y} + 0.5) / t.height * r.height]); })()`));
// UV of the vertex at a world position, on faces facing the given axis sign
const uvAt = (x, y, z, normal) => `(() => { let m = Mesh.all.find(m => m.name == 'box'); let out = [];
	for (let fkey in m.faces) { let f = m.faces[fkey]; if (f.getNormal(true).map(v => Math.round(v)).join(',') != '${normal}') continue;
		for (let vkey of f.vertices) { let p = m.vertices[vkey]; if (p[0] == ${x} && p[1] == ${y} && p[2] == ${z}) out.push({uv: f.uv[vkey].map(v => Math.round(v * 100) / 100), textured: !!f.texture}); } }
	return JSON.stringify(out); })()`;
const textured = `(() => { let m = Mesh.all.find(m => m.name == 'box'); let by = {}; for (let f of Object.values(m.faces)) { let n = f.getNormal(true).map(v => Math.round(v)).join(','); by[n] = (by[n] || 0) + (f.texture ? 1 : 0); } return JSON.stringify(by); })()`;

await ev(`(() => {
	newProject(Formats.dew_scene);
	let m = new Mesh({name: 'box', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	let axes = {x: ['z', 'y'], y: ['x', 'z'], z: ['x', 'y']};
	for (let axis of ['x', 'y', 'z']) for (let depth of [0, 32]) for (let u = 0; u < 32; u += 16) for (let v = 0; v < 32; v += 16) {
		let [ua, va] = axes[axis];
		let pt = (du, dv) => { let p = {}; p[axis] = depth; p[ua] = u + du; p[va] = v + dv; return [p.x, p.y, p.z]; };
		let f = new MeshFace(m, {vertices: [pt(0,0), pt(16,0), pt(16,16), pt(0,16)].map(vert), texture: false});
		m.addFaces(f); let n = f.getNormal(true); let i = {x: 0, y: 1, z: 2}[axis];
		if ((n[i] > 0) != (depth > 0)) f.invert();
	}
	m.init(); unselectAllElements();
	let p = Preview.selected; p.controls.target.set(16, 16, 16); p.camera.position.set(16 + 70, 16 + 55, 16 + 95); p.controls.update();
	return true; })()`);
await ev(`(() => { BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(400);
if (await ev(`!!Panels.uv.folded`)) await ev(`(() => { Panels.uv.fold(false); return true; })()`);
await sleep(200);

await ev(`(() => { BarItems.dew_texture_brush.select(); return true; })()`);
await sleep(150);
console.log('A. select texture brush:', await ev(`(() => { let v = UVEditor.vue;
	return JSON.stringify({tool: Toolbox.selected.id, selected_texture: Texture.selected?.name ?? null, uv_texture: v.texture?.name ?? v.texture, in_toolbar: Toolbars.tools.children.some(c => c.id == 'dew_texture_brush'), uv_shows_atlas: v.texture === Texture.all[0], overlay_grid: !!v.atlas_overlay?.grid, cell: v.atlas_overlay?.cell || null, displayed_uv_elements: v.getDisplayedUVElements().length, frame: !!v.$refs.frame}); })()`));

console.log('B. paint without a pick:', await ev(`(() => { return Undo.history.length; })()`));
await click([8, 24, 32]);
console.log('   textured faces after click with no pick:', await ev(textured), ' expect none');

await clickAt(await texel(24, 8));
console.log('C. pick texel (24,8) in the UV editor:', await ev(`JSON.stringify(DEWTileBrush.texture_state.atlas)`), ' cell style:', await ev(`JSON.stringify(UVEditor.vue.atlas_overlay.cell && [UVEditor.vue.atlas_overlay.cell.left, UVEditor.vue.atlas_overlay.cell.top, UVEditor.vue.atlas_overlay.cell.width])`), ' expect full tile cell 0%,0%,25%');
console.log('   face selection untouched by the pick:', await ev(`Outliner.selected.length`));

await click([8, 24, 32]);
console.log('D. full-tile paint on +z side:', await ev(textured), ' expect 0,0,1: 4');
console.log('   top-left corner (0,32,32):', await ev(uvAt(0, 32, 32, '0,0,1')), ' expect uv [0,0]');
console.log('   bottom-right corner (32,0,32):', await ev(uvAt(32, 0, 32, '0,0,1')), ' expect uv [32,32]');
console.log('   center (16,16,32) on all 4 quads:', await ev(uvAt(16, 16, 32, '0,0,1')), ' expect uv [16,16] x4');

await key('c');
await clickAt(await texel(56, 24));
console.log('E. C -> half, pick (56,24):', await ev(`JSON.stringify({size: DEWTileBrush.state.size, atlas: DEWTileBrush.texture_state.atlas, cell: [UVEditor.vue.atlas_overlay.cell.left, UVEditor.vue.atlas_overlay.cell.top, UVEditor.vue.atlas_overlay.cell.width]})`), ' expect 16, cell 37.5%,12.5%,12.5%');
await click([32, 8, 24]);
console.log('   half-tile paint on +x quad (z 16..32, y 0..16):', await ev(textured), ' expect 1,0,0: 1');
console.log('   its top-left from +x view (32,16,32):', await ev(uvAt(32, 16, 32, '1,0,0')), ' expect [48,16]');
console.log('   its bottom-right (32,0,16):', await ev(uvAt(32, 0, 16, '1,0,0')), ' expect [64,32]');
await ev(`Undo.undo(); true`);
console.log('   undo:', await ev(textured), ' expect 1,0,0: 0');

await drag([24, 32, 8], [24, 32, 24]);
console.log('F. half-tile drag across two +y quads:', await ev(textured), ' expect 0,1,0: 2');

await ev(`__noop = 0; true`).catch(() => {});
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_texture_brush.png', Buffer.from(shot.result.data, 'base64'));

console.log('G. back to move tool:', await ev(`(() => { BarItems.move_tool.select(); return new Promise(r => setTimeout(() => r(JSON.stringify({overlay: UVEditor.vue.atlas_overlay, displayed: UVEditor.vue.getDisplayedUVElements().length >= 0})), 50)); })()`));
console.log('H. export keeps texture:', await ev(`(async () => { let buf = await Codecs.gltf.compile(); let dv = new DataView(buf); let json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, dv.getUint32(12, true))));
	return JSON.stringify({images: (json.images || []).length, samplers: json.samplers, textured_materials: (json.materials || []).filter(m => m.pbrMetallicRoughness?.baseColorTexture).length}); })()`));
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
