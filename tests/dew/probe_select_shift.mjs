// What a plain drag and a shift drag actually select with the Tile Select tool.
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
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); return true; })()`);
	await sleep(150);
};
// modifiers bitmask: alt 1, ctrl 2, meta 4, shift 8
async function dragWorld(from, to, modifiers = 0, steps = 10) {
	const a = await screen(...from), b = await screen(...to);
	await mouse('mouseMoved', a, { button: 'none', modifiers }); await sleep(60);
	await mouse('mouseMoved', a, { button: 'none', modifiers }); await sleep(60);
	await mouse('mousePressed', a, { buttons: 1, modifiers }); await sleep(60);
	for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps], { buttons: 1, modifiers }); await sleep(30); }
	await mouse('mouseReleased', b, { modifiers }); await sleep(180);
}
const selected = `(() => { let n = 0, per = [];
	for (let m of Mesh.all) { let f = m.getSelectedFaces ? m.getSelectedFaces() : []; n += f.length; per.push(m.name + ':' + f.length); }
	return JSON.stringify({total: n, per, rect: !!document.querySelector('#selection_rectangle, .selection_rectangle')}); })()`;

await ev(`(() => {
	newProject(Formats.dew_scene);
	let m = new Mesh({name: 'floor', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	for (let x = 0; x < 64; x += 16) for (let z = 0; z < 64; z += 16) {
		let pt = (dx, dz) => [x + dx, 0, z + dz];
		let f = new MeshFace(m, {vertices: [pt(0,0), pt(16,0), pt(16,16), pt(0,16)].map(vert), texture: false});
		m.addFaces(f); if (f.getNormal(true)[1] < 0) f.invert(); }
	m.init(); unselectAllElements(); return true; })()`);
await camera(32, 0, 32, 120, 140, 120);
await ev(`(() => { BarItems.dew_tile_select.select(); DEWTileBrush.state.size = 16; return true; })()`);
await sleep(200);
console.log('area select keybind:', await ev(`JSON.stringify(Keybinds.extra.preview_area_select.keybind)`));

await dragWorld([8, 0, 8], [40, 0, 8], 0);
console.log('A. plain drag across a row of 3:', await ev(selected), ' expect 3');

await dragWorld([8, 0, 40], [40, 0, 40], 8);
console.log('B. shift drag across another row of 3:', await ev(selected), ' expect 6 if shift adds while dragging');

await ev(`(() => { unselectAllElements(); updateSelection(); return true; })()`);
await dragWorld([8, 0, 8], [8, 0, 8], 8, 2);
console.log('C. shift click one tile from empty:', await ev(selected), ' expect 1');

// Full tiles: a block is 4 faces, so DEW block selection and Blockbench's own per-face paint select differ
await ev(`(() => { unselectAllElements(); updateSelection(); DEWTileBrush.state.size = 32; return true; })()`);
await sleep(150);
await dragWorld([8, 0, 8], [40, 0, 8], 0);
console.log('D. plain drag across 2 full tiles:', await ev(selected), ' expect 8 faces, whole blocks');

await dragWorld([8, 0, 40], [40, 0, 40], 8);
console.log('E. shift drag across 2 more full tiles:', await ev(selected), ' expect 16: fewer means per-face select won');

console.log('page errors:', errors.length ? errors : 'none');
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_select_shift.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
