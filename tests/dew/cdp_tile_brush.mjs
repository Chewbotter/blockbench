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

// World point -> client coordinates in the selected preview
const screen = async (x, y, z) => JSON.parse(await ev(`(() => { let p = Preview.selected; let v = new THREE.Vector3(${x}, ${y}, ${z}).project(p.camera); let r = p.canvas.getBoundingClientRect(); return JSON.stringify([r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]); })()`));
const mouse = (type, [x, y], extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
async function click(world, modifiers = 0) {
	const at = await screen(...world);
	await mouse('mouseMoved', at, { button: 'none', modifiers }); await sleep(50);
	await mouse('mousePressed', at, { modifiers, buttons: 1 }); await sleep(50);
	await mouse('mouseReleased', at, { modifiers }); await sleep(80);
}
async function drag(from, to, steps = 12, modifiers = 0) {
	const a = await screen(...from), b = await screen(...to);
	await mouse('mouseMoved', a, { button: 'none', modifiers }); await sleep(30);
	await mouse('mousePressed', a, { modifiers, buttons: 1 }); await sleep(30);
	for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps], { modifiers, buttons: 1 }); await sleep(20); }
	await mouse('mouseReleased', b, { modifiers }); await sleep(80);
}
async function hover(world) { await mouse('mouseMoved', await screen(...world), { button: 'none' }); await sleep(60); }
async function key(letter) {
	const code = letter.toUpperCase().charCodeAt(0);
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await sleep(60);
}
const meshInfo = `(() => { let m = Mesh.all.find(m => m.name == 'tiles'); if (!m) return 'no tiles mesh';
	let faces = Object.values(m.faces); let n = faces.map(f => f.getNormal(true).map(v => Math.round(v)).join(','));
	let counts = {}; n.forEach(k => counts[k] = (counts[k] || 0) + 1);
	return JSON.stringify({faces: faces.length, vertices: Object.keys(m.vertices).length, normals: counts, textures: [...new Set(faces.map(f => f.texture))]}); })()`;
const brushState = `JSON.stringify(DEWTileBrush.state, (k, v) => k == 'hover_point' ? undefined : v)`;

console.log('A. setup:', await ev(`(() => { newProject(Formats.dew_scene); BarItems.selection_mode.set('face'); BarItems.dew_tile_brush.select();
	return JSON.stringify({tool: Toolbox.selected.id, in_toolbar: Toolbars.tools.children.some(c => c.id == 'dew_tile_brush'), selection_mode: BarItems.selection_mode.value, plane_grid: !!Canvas.scene.getObjectByName('dew_plane_grid'), keybinds: ['dew_tile_plane_axis','dew_tile_plane_back','dew_tile_plane_forward','dew_tile_size'].map(id => BarItems[id].keybind.label)}); })()`));

await hover([100, 0, 100]);
console.log('B. hover ghost:', await ev(`!!Canvas.scene.getObjectByName('dew_tile_ghost')`));

await click([40, 0, 40]);
console.log('C. click full tile at (40,0,40):', await ev(meshInfo), ' expect 4 faces, 9 verts, all 0,1,0');
console.log('   selected:', await ev(`Mesh.selected.map(m => m.name).join(',')`), ' undo:', await ev(`Undo.history.at(-1)?.action`));

await drag([40, 0, 40], [150, 0, 40]);
console.log('D. drag along x to 150:', await ev(meshInfo), ' expect 16 faces, 27 verts');

await key('c');
console.log('E. C toggles half tile:', await ev(brushState));

// Wall: hover over the floor tile, W re-aims the plane through the hover point, then click on the floor
await hover([100, 0, 50]);
await key('w');
console.log('F. W after hovering (100,0,50):', await ev(brushState), ' expect axis x, depth 96 or 112 (snapped hover x)');
await click([100, 0, 50]);
console.log('   click on floor with wall axis:', await ev(meshInfo), ' expect 17 faces, one normal 1,0,0');
console.log('   wall tile:', await ev(`(() => { let m = Mesh.all.find(m => m.name == 'tiles'); let f = Object.values(m.faces).find(f => Math.round(f.getNormal(true)[0]) != 0); return JSON.stringify(f.vertices.map(v => m.vertices[v])); })()`));

await key('d');
console.log('G. D steps plane:', await ev(brushState));
await key('a');
console.log('   A steps back:', await ev(brushState));

// Erase one half tile with Ctrl+click on the floor
await key('w'); await key('w');   // back to floor
await hover([140, 0, 36]);
await click([140, 0, 36], 2);
console.log('H. ctrl+click erase:', await ev(meshInfo), ' expect 16 faces, loose verts removed');
await ev(`Undo.undo()`);
console.log('   undo restores:', await ev(meshInfo));
await hover([96, 8, 56]);
await click([96, 8, 56], 2);
console.log('   ctrl+click the wall tile:', await ev(meshInfo), ' expect 16 faces, 27 verts (its two top verts removed)');
await ev(`Undo.undo(); true`);

console.log('I. keys inert with another tool:', await ev(`(() => { BarItems.move_tool.select(); let before = ${brushState}; return before; })()`));
await key('w'); await key('d');
console.log('   after W, D with move tool:', await ev(brushState), ' plane grid gone:', await ev(`!Canvas.scene.getObjectByName('dew_plane_grid') && !Canvas.scene.getObjectByName('dew_tile_ghost')`), ' selection mode restored:', await ev(`BarItems.selection_mode.value`));

console.log('J. export:', await ev(`(async () => { let buf = await Codecs.gltf.compile(); let dv = new DataView(buf); let json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, dv.getUint32(12, true))));
	return JSON.stringify(json.meshes.map((m, i) => ({name: json.nodes.find(n => n.mesh == i).name, min: json.accessors[m.primitives[0].attributes.POSITION].min, max: json.accessors[m.primitives[0].attributes.POSITION].max}))); })()`), ' expect min [2,0,2] max [10,1,4]');

await ev(`BarItems.dew_tile_brush.select(); true`);
await hover([200, 0, 200]);
await sleep(300);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_tile_brush.png', Buffer.from(shot.result.data, 'base64'));

console.log('K. switch to Generic drops the brush:', await ev(`(() => { newProject(Formats.free); return JSON.stringify({tool: Toolbox.selected.id, plane_grid: !!Canvas.scene.getObjectByName('dew_plane_grid'), ghost: !!Canvas.scene.getObjectByName('dew_tile_ghost'), brush_visible: Condition(BarItems.dew_tile_brush.condition)}); })()`));

console.log('page errors:', errors.length ? errors : 'none');
ws.close();
