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

const SHIFT = 8, CTRL = 2;
const screen = async (x, y, z) => JSON.parse(await ev(`(() => { let p = Preview.selected; let v = new THREE.Vector3(${x}, ${y}, ${z}).project(p.camera); let r = p.canvas.getBoundingClientRect(); return JSON.stringify([r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]); })()`));
const mouse = (type, [x, y], extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
async function dragPx(a, b, steps = 10, modifiers = 0) {
	await mouse('mouseMoved', a, { button: 'none', modifiers }); await sleep(40);
	await mouse('mousePressed', a, { buttons: 1, modifiers }); await sleep(40);
	for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps], { buttons: 1, modifiers }); await sleep(25); }
	await mouse('mouseReleased', b, { modifiers }); await sleep(100);
}
const click = async (world, modifiers = 0) => { let at = await screen(...world); return dragPx(at, at, 1, modifiers); };
const drag = async (from, to, modifiers = 0) => dragPx(await screen(...from), await screen(...to), 16, modifiers);
async function key(letter) {
	const code = letter.toUpperCase().charCodeAt(0);
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await sleep(80);
}
const texel = async (x, y) => JSON.parse(await ev(`(() => { let f = UVEditor.vue.$refs.frame; let r = f.getBoundingClientRect(); let cs = getComputedStyle(f);
	let bl = parseFloat(cs.borderLeftWidth), bt = parseFloat(cs.borderTopWidth); let t = UVEditor.vue.texture;
	return JSON.stringify([r.left + bl + (${x} + 0.5) / t.width * f.clientWidth, r.top + bt + (${y} + 0.5) / t.height * f.clientHeight]); })()`));
// Selected tiles per mesh as sorted min corners, plus selected vertex counts
const selection = `(() => { let out = {elements: Outliner.selected.map(e => e.name)};
	for (let m of Mesh.all) { let faces = m.getSelectedFaces(); if (!faces.length) continue;
		out[m.name] = {faces: faces.map(k => { let ps = m.faces[k].vertices.map(v => m.vertices[v]); return [0, 2].map(i => Math.min(...ps.map(p => p[i]))).join(','); }).sort(), vertices: m.getSelectedVertices().length}; }
	return JSON.stringify(out); })()`;
const textured = `(() => { let out = {}; for (let m of Mesh.all) out[m.name] = Object.values(m.faces).filter(f => f.texture).length; return JSON.stringify(out); })()`;
const face = (x, y, z, normal) => `(() => { for (let m of Mesh.all) for (let f of Object.values(m.faces)) {
	if (f.getNormal(true).map(v => Math.round(v)).join(',') != '${normal}') continue;
	let ps = f.vertices.map(k => m.vertices[k]); let min = [0, 1, 2].map(i => Math.min(...ps.map(p => p[i])));
	if (min.join(',') != '${x},${y},${z}') continue;
	let out = {textured: !!f.texture}; f.vertices.forEach(k => out[m.vertices[k].join(',')] = f.uv[k].map(v => Math.round(v * 100) / 100)); return JSON.stringify(out); } return 'no face'; })()`;

// floor x 0..128 z 0..64; floor2 x 128..160 z 0..64 (touching); island x 192..224 z 0..32 (gap); wall x 0..64 y 0..32 at z = 0 facing +z
await ev(`(() => {
	newProject(Formats.dew_scene);
	let build = (name, axis, depth, sign, u0, v0, nu, nv) => { let m = new Mesh({name, vertices: {}}); let map = {};
		let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
		let axes = {x: ['z', 'y'], y: ['x', 'z'], z: ['x', 'y']}; let [ua, va] = axes[axis];
		for (let u = u0; u < u0 + nu * 16; u += 16) for (let v = v0; v < v0 + nv * 16; v += 16) {
			let pt = (du, dv) => { let p = {}; p[axis] = depth; p[ua] = u + du; p[va] = v + dv; return [p.x, p.y, p.z]; };
			let f = new MeshFace(m, {vertices: [pt(0,0), pt(16,0), pt(16,16), pt(0,16)].map(vert), texture: false});
			m.addFaces(f); if (f.getNormal(true)[{x: 0, y: 1, z: 2}[axis]] * sign < 0) f.invert();
		}
		m.init(); return m; };
	build('floor', 'y', 0, 1, 0, 0, 8, 4); build('floor2', 'y', 0, 1, 128, 0, 2, 4); build('island', 'y', 0, 1, 192, 0, 2, 2); build('wall', 'z', 0, 1, 0, 0, 4, 2);
	unselectAllElements();
	let p = Preview.selected; p.controls.target.set(112, 0, 32); p.camera.position.set(112, 190, 230); p.controls.update();
	return true; })()`);

console.log('undo_selections setting was:', await ev(`(() => { let before = settings.undo_selections.value; settings.undo_selections.value = true; return before; })()`));
console.log('A. tile select tool:', await ev(`(() => { BarItems.dew_tile_select.select(); let ids = Toolbars.tools.children.map(c => c.id); let i = ids.indexOf('dew_tile_brush');
	return JSON.stringify({tool: Toolbox.selected.id, selection_mode: BarItems.selection_mode.value, order: ids.slice(i - 1, i + 3)}); })()`), ' expect face, order select, tile, texture, bucket');
await key('c');
await click([24, 0, 24]);
console.log('B. half-tile click selects one tile:', await ev(selection), ' expect floor [16,16], 4 vertices');
await drag([24, 0, 24], [72, 0, 24]);
console.log('C. plain drag replaces:', await ev(selection), ' expect floor 16..64 on z 16 (4 tiles), 10 vertices');
await drag([40, 0, 40], [72, 0, 40], SHIFT);
console.log('D. shift drag adds:', await ev(selection), ' expect + 32,32 48,32 64,32 (7 tiles)');
await click([24, 0, 24], CTRL);
console.log('E. ctrl click removes:', await ev(selection), ' expect 6 tiles, no 16,16');
await key('c');
await click([24, 0, 24]);
console.log('F. full-tile click replaces with a 2x2 block:', await ev(selection), ' expect 0,0 0,16 16,0 16,16');
console.log('G. empty spot on screen at', JSON.stringify((await screen(112, 0, -60)).map(Math.round)), 'canvas', await ev(`JSON.stringify((r => [r.left, r.top, r.right, r.bottom].map(Math.round))(Preview.selected.canvas.getBoundingClientRect()))`));
await click([112, 0, -60]);
console.log('   click on empty space clears:', await ev(selection), ' expect no faces');
await ev(`Undo.undo(); true`);
console.log('H. undo restores:', await ev(selection), ' expect the 2x2 block');
await ev(`(() => { BarItems.move_tool.select(); return true; })()`);
await sleep(60);
console.log('I. move tool keeps the face selection:', await ev(`BarItems.selection_mode.value`), await ev(selection));

await ev(`(() => { BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(400);
if (await ev(`!!Panels.uv.folded`)) await ev(`(() => { Panels.uv.fold(false); return true; })()`);
await ev(`(() => { unselectAllElements(); BarItems.dew_paint_bucket.select(); return true; })()`);
await sleep(150);
await key('c');
console.log('J. bucket tool:', await ev(`JSON.stringify({tool: Toolbox.selected.id, uv_texture: UVEditor.vue.texture?.name, grid: !!UVEditor.vue.atlas_overlay?.grid, size: DEWTileBrush.state.size})`));
await dragPx(await texel(4, 4), await texel(24, 24));
console.log('   pick 2 x 2:', await ev(`JSON.stringify(UVEditor.vue.atlas_overlay.cell && ['left','top','width','height'].map(k => UVEditor.vue.atlas_overlay.cell[k]))`), ' expect 0%,0%,25%,25%');
await click([24, 0, 24]);
console.log('K. bucket on the floor:', await ev(textured), ' expect floor 32, floor2 8, island 0, wall 0');
console.log('L. tiling from the origin: (0,0,0):', await ev(face(0, 0, 0, '0,1,0')), ' expect 0,0,0 -> [0,0]');
console.log('   (16,0,0):', await ev(face(16, 0, 0, '0,1,0')), ' expect 16,0,0 -> [16,0]');
console.log('   (32,0,16):', await ev(face(32, 0, 16, '0,1,0')), ' expect 32,0,16 -> [0,16]');
console.log('   floor2 (128,0,0):', await ev(face(128, 0, 0, '0,1,0')), ' expect 128,0,0 -> [0,0]');
await ev(`Undo.undo(); true`);
console.log('M. undo:', await ev(textured), ' expect all 0');
await click([8, 8, 0]);
console.log('N. bucket on the wall:', await ev(textured), ' expect wall 8 only');
console.log('   wall (0,0,0) top-left corner (0,16,0):', await ev(face(0, 0, 0, '0,0,1')), ' expect 0,16,0 -> [0,0]');

await click([24, 0, 24]);
await ev(`(() => { BarItems.dew_tile_select.select(); return true; })()`);
await drag([24, 0, 8], [72, 0, 40]);
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_select_bucket.png', Buffer.from(shot.result.data, 'base64'));
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
