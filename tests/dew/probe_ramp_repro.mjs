// Builds a floor and a wall with the actual tile brush, the way a user would, then asks the ramp tool what it
// sees at the corner. Not part of the suite: a diagnosis aid (run without --isolated to use the real profile).
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
const hover = async world => { await mouse('mouseMoved', await screen(...world), { button: 'none' }); await sleep(90); };
async function click(world) {
	const at = await screen(...world);
	await mouse('mouseMoved', at, { button: 'none' }); await sleep(50);
	await mouse('mousePressed', at, { buttons: 1 }); await sleep(50);
	await mouse('mouseReleased', at); await sleep(120);
}
async function drag(from, to, steps = 12) {
	const a = await screen(...from), b = await screen(...to);
	await mouse('mouseMoved', a, { button: 'none' }); await sleep(40);
	await mouse('mousePressed', a, { buttons: 1 }); await sleep(40);
	for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps], { buttons: 1 }); await sleep(25); }
	await mouse('mouseReleased', b); await sleep(120);
}
async function key(letter) {
	const code = letter.toUpperCase().charCodeAt(0);
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await sleep(90);
}
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); return true; })()`);
	await sleep(150);
};
// What the ramp tool sees at a world point
const look = async (x, y, z) => ev(`(() => { let p = Preview.selected; let v = new THREE.Vector3(${x}, ${y}, ${z}).project(p.camera); let r = p.canvas.getBoundingClientRect();
	let e = {clientX: r.left + (v.x + 1) / 2 * r.width, clientY: r.top + (1 - v.y) / 2 * r.height, target: p.canvas};
	let hit = DEWTileBrush.hitFace(p, e);
	let tile = hit && DEWTileBrush.describeTile(hit.element, hit.element.faces[hit.face]);
	let tiles = DEWTileBrush.buildTileIndex();
	let ramp = DEWTileBrush.shaveTarget(p, e, tiles, true), shave = DEWTileBrush.shaveTarget(p, e, tiles, false);
	let target = t => t && {edge_axis: t.n, edge_at: t.e, edge_side: t.s2, along: t.al + ' ' + t.lo + '..' + t.hi};
	return JSON.stringify({size: DEWTileBrush.state.size, mesh: hit && hit.element.name,
		tile: tile && {plane: tile.axis + ' ' + tile.depth, facing: tile.sign, corner: tile.u + ',' + tile.v},
		ramp: target(ramp), shave: target(shave)}); })()`);
const tiles = `(() => { let out = {}; for (let m of Mesh.all) { for (let fkey in m.faces) { let t = DEWTileBrush.describeTile(m, m.faces[fkey]); if (!t) continue;
	let key = t.axis + ' ' + t.depth + ' facing ' + t.sign; (out[key] = out[key] || []).push(t.u + ',' + t.v); } }
	for (let k in out) out[k] = out[k].sort().join(' | '); return JSON.stringify(out, null, 1); })()`;

await ev(`(() => { newProject(Formats.dew_scene); return true; })()`);
await camera(64, 16, 64, 64 + 130, 16 + 120, 64 + 170);
await ev(`(() => { BarItems.dew_tile_brush.select(); return true; })()`);
await key('c');   // half tiles
// Paint a patch of floor, then switch the work plane to a wall and raise one stretch of wall on it
await drag([40, 0, 40], [104, 0, 40]);
await drag([40, 0, 56], [104, 0, 56]);
await hover([72, 0, 40]);
await key('w');
console.log('plane after W:', await ev(`JSON.stringify(DEWTileBrush.state)`));
await click([72, 0, 44]);
await click([72, 0, 60]);
console.log('tiles built by the brush:\n', await ev(tiles));

await ev(`(() => { BarItems.dew_ramp.select(); return true; })()`);
await sleep(150);
// The wall lands on x 80 facing +x, so the floor at x 80..96 is the side it faces and x 64..80 is its back
for (let point of [[84, 0, 50], [88, 0, 40], [68, 0, 50], [82, 8, 50]]) {
	await hover(point);
	console.log(`half tile at ${point.join(',')}: ghost`, await ev(`!!Canvas.scene.getObjectByName('dew_tile_ghost')`), await look(...point));
}
await key('c');   // full tiles, against a 16 tall wall
for (let point of [[84, 0, 50], [82, 8, 50]]) {
	await hover(point);
	console.log(`full tile at ${point.join(',')}: ghost`, await ev(`!!Canvas.scene.getObjectByName('dew_tile_ghost')`), await look(...point));
}
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
