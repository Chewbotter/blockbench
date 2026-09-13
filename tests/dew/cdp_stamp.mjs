// Texture brush picks: atlas cells are half cells whatever C says, and the brush lays the pick over its own footprint
// from the upper left, repeating a pick smaller than the footprint and cutting off a larger one.
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
async function dragPx(a, b, steps = 10) {
	await mouse('mouseMoved', a, { button: 'none' }); await sleep(40);
	await mouse('mousePressed', a, { buttons: 1 }); await sleep(40);
	for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps], { buttons: 1 }); await sleep(25); }
	await mouse('mouseReleased', b); await sleep(100);
}
const clickAt = async at => dragPx(at, at, 1);
const click = async world => { await hover(world); await clickAt(await screen(...world)); };
const hover = async world => { const at = await screen(...world); for (let i = 0; i < 2; i++) { await mouse('mouseMoved', at, { button: 'none' }); await sleep(80); } };
async function key(letter) {
	const code = letter.toUpperCase().charCodeAt(0);
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await sleep(80);
}
// Texel center in the UV editor; the frame's content box starts inside its border like the click coordinates do
const texel = async (x, y) => JSON.parse(await ev(`(() => { let f = UVEditor.vue.$refs.frame; let r = f.getBoundingClientRect(); let cs = getComputedStyle(f);
	let bl = parseFloat(cs.borderLeftWidth), bt = parseFloat(cs.borderTopWidth); let w = f.clientWidth, h = f.clientHeight; let t = UVEditor.vue.texture;
	return JSON.stringify([r.left + bl + (${x} + 0.5) / t.width * w, r.top + bt + (${y} + 0.5) / t.height * h]); })()`));
// The atlas cell a tile carries: the lowest uv corner of the tile whose min corner is (x, y, z) and whose normal matches
const cell = (x, y, z, normal) => `(() => { for (let m of Mesh.all) for (let f of Object.values(m.faces)) {
	if (f.getNormal(true).map(v => Math.round(v)).join(',') != '${normal}') continue;
	let ps = f.vertices.map(k => m.vertices[k]); let min = [0, 1, 2].map(i => Math.min(...ps.map(p => p[i])));
	if (min.join(',') != '${x},${y},${z}') continue;
	if (!f.texture) return 'untextured';
	let uvs = f.vertices.map(k => f.uv[k]); return JSON.stringify([0, 1].map(i => Math.round(Math.min(...uvs.map(uv => uv[i]))))); } return 'no face'; })()`;
const textured = `(() => { let by = {}; for (let m of Mesh.all) for (let f of Object.values(m.faces)) { let n = f.getNormal(true).map(v => Math.round(v)).join(','); by[n] = (by[n] || 0) + (f.texture ? 1 : 0); } return JSON.stringify(by); })()`;
const region = () => `JSON.stringify({atlas: DEWTileBrush.texture_state.atlas && (({x0, y0, x1, y1}) => [x0, y0, x1, y1])(DEWTileBrush.texture_state.atlas), cell: UVEditor.vue.atlas_overlay?.cell && ['left', 'top', 'width', 'height'].map(k => UVEditor.vue.atlas_overlay.cell[k])})`;

// Floor of 8 x 4 half tiles (x 0..128, z 0..64) facing up, and a wall of 4 x 2 half tiles (x 0..64, y 0..32) at z = 0 facing +z
await ev(`(() => {
	newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove());
	let build = (name, axis, depth, sign, nu, nv) => { let m = new Mesh({name, vertices: {}}); let map = {};
		let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
		let axes = {x: ['z', 'y'], y: ['x', 'z'], z: ['x', 'y']}; let [ua, va] = axes[axis];
		for (let u = 0; u < nu * 16; u += 16) for (let v = 0; v < nv * 16; v += 16) {
			let pt = (du, dv) => { let p = {}; p[axis] = depth; p[ua] = u + du; p[va] = v + dv; return [p.x, p.y, p.z]; };
			let f = new MeshFace(m, {vertices: [pt(0,0), pt(16,0), pt(16,16), pt(0,16)].map(vert), texture: false});
			m.addFaces(f); if (f.getNormal(true)[{x: 0, y: 1, z: 2}[axis]] * sign < 0) f.invert();
		}
		m.init(); return m; };
	build('floor', 'y', 0, 1, 8, 4); build('wall', 'z', 0, 1, 4, 2);
	unselectAllElements();
	let p = Preview.selected; p.controls.target.set(64, 0, 32); p.camera.position.set(64, 150, 190); p.controls.update();
	return true; })()`);
await ev(`(() => { BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(400);
if (await ev(`!!Panels.uv.folded`)) await ev(`(() => { Panels.uv.fold(false); return true; })()`);
await ev(`(() => { BarItems.dew_texture_brush.select(); DEWTileBrush.state.size = 32; return true; })()`);
await sleep(150);
console.log('setup:', await ev(`JSON.stringify({tool: Toolbox.selected.id, size: DEWTileBrush.state.size, uv_texture: UVEditor.vue.texture?.name})`), ' expect size 32');

await dragPx(await texel(8, 8), await texel(40, 24));
console.log('A. drag-pick texels (8,8) to (40,24) at full size:', await ev(region()), ' expect 3 x 2 half cells: 0%,0%,37.5%,25%');

await hover([24, 0, 24]);
console.log('B. ghost over floor tile (16,16):', await ev(`(() => { let g = Canvas.scene.getObjectByName('dew_tile_ghost'); if (!g) return 'no ghost'; let s = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3()); return [s.x, s.z].map(Math.round).join(' x '); })()`), ' expect 32 x 32, the footprint');

await click([24, 0, 24]);
console.log('C. a 3 x 2 pick on a 2 x 2 footprint:', await ev(textured), ' expect 0,1,0: 4');
console.log('   tile (0,0,0):', await ev(cell(0, 0, 0, '0,1,0')), ' expect [0,0]');
console.log('   tile (16,0,0):', await ev(cell(16, 0, 0, '0,1,0')), ' expect [16,0]');
console.log('   tile (16,0,16):', await ev(cell(16, 0, 16, '0,1,0')), ' expect [16,16]: the upper left 2 x 2, column 32 unused');
console.log('   tile (32,0,0):', await ev(cell(32, 0, 0, '0,1,0')), ' expect untextured, outside the footprint');

await clickAt(await texel(56, 8));
console.log('D. pick one cell (3,0):', await ev(region()), ' expect 37.5%,0%,12.5%,12.5%');
await click([56, 0, 8]);
console.log('   one cell on a 2 x 2 footprint:', await ev(textured), ' expect 0,1,0: 8');
console.log('   tiles (32,0,0) and (48,0,16):', await ev(cell(32, 0, 0, '0,1,0')), await ev(cell(48, 0, 16, '0,1,0')), ' expect [48,0] both: all four take the one cell');

await dragPx(await texel(8, 40), await texel(24, 40));
console.log('E. pick 2 x 1 at row 2:', await ev(region()), ' expect 0%,25%,25%,12.5%');
await click([8, 24, 0]);
console.log('   on the wall footprint x 0..32, y 0..32:', await ev(textured), ' expect 0,0,1: 4');
console.log('   wall tiles (0,16,0) and (16,0,0):', await ev(cell(0, 16, 0, '0,0,1')), await ev(cell(16, 0, 0, '0,0,1')), ' expect [0,32] and [16,32]: the row repeats down the footprint');

await ev(`(() => { DEWTileBrush.state.size = 16; return true; })()`);
console.log('F. half size keeps the pick:', await ev(region()), ' expect 0%,25%,25%,12.5% unchanged');
await click([40, 8, 0]);
console.log('   wall tile (32,0,0):', await ev(cell(32, 0, 0, '0,0,1')), ' expect [0,32]: a half footprint holds only the upper left cell');

await ev(`Undo.undo(); true`);
console.log('G. undo the half paint:', await ev(textured), ' expect 0,0,1: 4');

// The tile brush textures what it lays, tiling a 2 x 2 pick from the plane origin like the bucket
await ev(`(() => { BarItems.dew_tile_brush.select(); unselectAllElements(); let s = DEWTileBrush.state; s.size = 32; s.axis = 'y'; s.depth = 0; s.sign = null;
	DEWTileBrush.texture_state.atlas = {texture: Texture.all[0].uuid, x0: 0, y0: 0, x1: 16, y1: 16, shape: 'square'}; return true; })()`);
await sleep(200);
console.log('H. tile brush offers the atlas:', await ev(`JSON.stringify({picker: !!BarItems.dew_tile_brush.atlas_picker, overlay: !!UVEditor.vue.atlas_overlay?.cell})`), ' expect both true');
await click([24, 0, 88]);
console.log('   tiles (0,0,80), (16,0,80), (0,0,64), (16,0,64):', await ev(cell(0, 0, 80, '0,1,0')), await ev(cell(16, 0, 80, '0,1,0')), await ev(cell(0, 0, 64, '0,1,0')), await ev(cell(16, 0, 64, '0,1,0')));
console.log('   expect [0,16] [16,16] [0,0] [16,0]: column by x / 16, row by z / 16, both mod 2 (z 80 is row 1, z 64 row 0)');

await hover([24, 0, 24]);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_stamp.png', Buffer.from(shot.result.data, 'base64'));
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
