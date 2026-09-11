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
const hover = async world => { await mouse('mouseMoved', await screen(...world), { button: 'none' }); await sleep(80); };
async function click(world) {
	const at = await screen(...world);
	await mouse('mouseMoved', at, { button: 'none' }); await sleep(40);
	await mouse('mousePressed', at, { buttons: 1 }); await sleep(40);
	await mouse('mouseReleased', at); await sleep(120);
}
async function key(letter) {
	const code = letter.toUpperCase().charCodeAt(0);
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await sleep(80);
}
// The camera matrix that world points project through only updates on render, so wait a frame before clicking
const camera = async (tx, ty, tz, px, py, pz) => {
	await ev(`(() => { let p = Preview.selected; p.controls.target.set(${tx}, ${ty}, ${tz}); p.camera.position.set(${px}, ${py}, ${pz}); p.controls.update(); return true; })()`);
	await sleep(150);
};
const counts = `(() => { let out = {}; for (let m of Mesh.all) out[m.name] = Object.keys(m.faces).length;
	out.untextured_new = 0;
	for (let m of Mesh.all) for (let f of Object.values(m.faces)) { let n = f.getNormal(true); let slanted = n.filter(v => Math.abs(v) > 0.01).length > 1;
		if ((slanted || f.vertices.length == 3) && !f.texture) out.untextured_new++; }
	return JSON.stringify(out); })()`;
// Slanted faces and triangles of a mesh with their corners, normals and UVs
const shapes = name => `(() => { let m = Mesh.all.find(m => m.name == '${name}'); let r = v => Math.round(v * 100) / 100;
	let out = [];
	for (let f of Object.values(m.faces)) { let n = f.getNormal(true); if (f.vertices.length == 4 && n.filter(v => Math.abs(v) > 0.01).length < 2) continue;
		out.push({n: n.map(r).join(','), p: f.vertices.map(k => m.vertices[k].map(r).join(',') + ' uv ' + f.uv[k].map(r).join(',')).sort(), textured: !!f.texture}); }
	return JSON.stringify(out); })()`;

// floor y 0 (4x4 tiles), wall_z at z 0 facing +z (4x3 tall), wall_x at x 0 facing +x (4x2), ceiling y 48 facing down
await ev(`(() => {
	newProject(Formats.dew_scene);
	window.__build = (name, list) => { let m = new Mesh({name, vertices: {}}); let map = {};
		let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
		let axes = {x: ['z', 'y'], y: ['x', 'z'], z: ['x', 'y']};
		for (let [axis, depth, sign, u0, v0, nu, nv] of list) { let [ua, va] = axes[axis];
			for (let u = u0; u < u0 + nu * 16; u += 16) for (let v = v0; v < v0 + nv * 16; v += 16) {
				let pt = (du, dv) => { let p = {}; p[axis] = depth; p[ua] = u + du; p[va] = v + dv; return [p.x, p.y, p.z]; };
				let f = new MeshFace(m, {vertices: [pt(0,0), pt(16,0), pt(16,16), pt(0,16)].map(vert), texture: false});
				m.addFaces(f); if (f.getNormal(true)[{x: 0, y: 1, z: 2}[axis]] * sign < 0) f.invert();
			} }
		m.init(); return m; };
	__build('floor', [['y', 0, 1, 0, 0, 4, 4]]);
	__build('wall_z', [['z', 0, 1, 0, 0, 4, 3]]);
	__build('wall_x', [['x', 0, 1, 0, 0, 4, 2]]);
	__build('ceiling', [['y', 48, -1, 0, 0, 4, 4]]);
	unselectAllElements(); return true; })()`);
await ev(`(() => { BarItems.create_dew_atlas.click(); Dialog.open.confirm(); return true; })()`);
await sleep(400);
// Floor takes atlas cell (0,0), ceiling cell (32,0), so new faces can be checked for texture
await ev(`(() => { let t = Texture.all[0];
	for (let [name, cell] of [['floor', 0], ['ceiling', 32]]) { let m = Mesh.all.find(m => m.name == name);
		for (let f of Object.values(m.faces)) { let ps = f.vertices.map(k => m.vertices[k]);
			let x0 = Math.min(...ps.map(p => p[0])), z0 = Math.min(...ps.map(p => p[2]));
			f.texture = t.uuid; f.vertices.forEach(k => f.uv[k] = [cell + (m.vertices[k][0] - x0), m.vertices[k][2] - z0]); }
		Canvas.updateView({elements: [m], element_aspects: {faces: true, uv: true}}); }
	return true; })()`);
await camera(32, 16, 32, 32 + 120, 16 + 90, 32 + 150);
await ev(`(() => { BarItems.dew_ramp.select(); return true; })()`);
await key('c');
console.log('setup:', await ev(`JSON.stringify({tool: Toolbox.selected.id, size: DEWTileBrush.state.size, order: (ids => ids.slice(ids.indexOf('dew_shave'), ids.indexOf('dew_shave') + 2))(Toolbars.tools.children.map(c => c.id))})`), ' expect dew_ramp after dew_shave');
console.log('start:', await ev(counts), ' expect floor 16, wall_z 12, wall_x 8, ceiling 16');

await hover([24, 0, 6]);
console.log('A. hover on the floor by the wall:', await ev(`!!Canvas.scene.getObjectByName('dew_tile_ghost')`), ' expect true');
await hover([24, 0, 40]);
console.log('B. hover mid floor:', await ev(`!!Canvas.scene.getObjectByName('dew_tile_ghost')`), ' expect true: any edge now offers a free diagonal');

await click([24, 0, 6]);
console.log('C. ramp the floor/wall corner at x 16..32:', await ev(counts), ' expect floor 18 (tile out, slope plus two ends in), wall_z 11, untextured_new 0');
console.log('   shapes:', await ev(shapes('floor')));
console.log('   expect slope 16,0,16 uv 0,16 / 32,0,16 uv 16,16 / 32,16,0 uv 16,0 / 16,16,0 uv 0,0, normal 0,0.71,0.71; two end triangles facing -x and +x');

await click([40, 0, 6]);
console.log('D. ramp the next stretch:', await ev(counts), ' expect floor 18 (shared end triangle removed), wall_z 10');

await click([8, 0, 6]);
console.log('E. ramp up to the side wall:', await ev(counts), ' expect floor 17: no end triangle where wall_x closes it, shared one removed');

// Inside the room, so the ray reaches the ceiling without crossing the floor
await camera(32, 40, 8, 40, 30, 120);
console.log('   what the ceiling click lands on:', await ev(`(() => { let p = Preview.selected; let v = new THREE.Vector3(24, 48, 6).project(p.camera); let r = p.canvas.getBoundingClientRect();
	let e = {clientX: r.left + (v.x + 1) / 2 * r.width, clientY: r.top + (1 - v.y) / 2 * r.height, target: p.canvas};
	let hit = DEWTileBrush.hitFace(p, e);
	let tile = hit && DEWTileBrush.describeTile(hit.element, hit.element.faces[hit.face]);
	let target = DEWTileBrush.shaveTarget(p, e, DEWTileBrush.buildTileIndex(), true);
	return JSON.stringify({on_canvas: e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom,
		mesh: hit && hit.element.name, tile: tile && [tile.axis, tile.depth, tile.sign, tile.u, tile.v].join(' '),
		corner: target && [target.n, target.e, target.s2, target.al, target.lo].join(' ')}); })()`));
await click([24, 48, 6]);
console.log('F. ramp the ceiling/wall corner (underside trim):', await ev(counts), ' expect ceiling 18, wall_z 8, untextured_new 0');
console.log('   shapes:', await ev(shapes('ceiling')));
console.log('   expect slope 16,48,16 / 32,48,16 / 32,32,0 / 16,32,0, normal 0,-0.71,0.71');

await ev(`Undo.undo(); true`);
console.log('G. undo:', await ev(counts), ' expect ceiling 16, wall_z 9');

await camera(32, 16, 32, 32 + 120, 16 + 90, 32 + 150);
await hover([56, 0, 6]);
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_ramp.png', Buffer.from(shot.result.data, 'base64'));
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
