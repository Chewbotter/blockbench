// OBJ import splits concave polygons without overlap: an L, a U, the same L listed the other way round, a rectangle
// with a corner in the middle of one side, and a concave quad come in as triangles and convex quads covering exactly
// the polygon's area with every corner kept (polygon_pieces.ts). Then the user's house, 01.obj (533 n-gons, 132
// concave), where the old fan drew 72 polygons too large: the drawn area now equals the file's. The convex path
// (a fan) is covered by cdp_obj_ngons.mjs.
import assert from 'assert';
import fs from 'fs';
const HOUSE = process.env.PROBE_FILE || 'D:/Work/Lanterns/source_content/houses/obj_1-40/01.obj';
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type == 'page' && t.url.includes('index.html')) ?? targets.find(t => t.type == 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method == 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result.result.value; };
const json = async (expr) => JSON.parse(await ev(expr));
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { if (await ev('typeof Blockbench != "undefined" && !!window.Preview && Preview.all.length > 0')) break; await sleep(500); }
await send('Runtime.enable');
let passed = 0;
const check = (name, ok, detail) => { assert.ok(ok, name + (detail !== undefined ? ': ' + JSON.stringify(detail) : '')); console.log('PASS', name); passed++; };

// Outlines in the XZ plane, each at its own x offset, listed as (x, z); the file's normal points up
const shapes = {
	L: {at: 0, xz: [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]},
	U: {at: 4, xz: [[0, 0], [3, 0], [3, 2], [2, 2], [2, 1], [1, 1], [1, 2], [0, 2]]},
	L_reversed: {at: 9, xz: [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]].reverse()},
	midpoint: {at: 13, xz: [[0, 0], [1, 0], [2, 0], [2, 1], [0, 1]]},
	dart: {at: 17, xz: [[0, 0], [2, 1], [0, 2], [0.5, 1]]},
};
const shoelace = xz => Math.abs(xz.reduce((a, p, i) => { let q = xz[(i + 1) % xz.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
let lines = ['o concave'], index = 1;
for (let [name, shape] of Object.entries(shapes)) {
	shape.first = index;
	for (let [x, z] of shape.xz) { lines.push(`v ${x + shape.at} 0 ${z}`); lines.push(`vt ${x / 3} ${z / 3}`); index++; }
}
lines.push('vn 0 1 0');
for (let shape of Object.values(shapes)) lines.push('f ' + shape.xz.map((_, i) => `${shape.first + i}/${shape.first + i}/1`).join(' '));
const obj = lines.join('\n');

const result = await json(`(async () => {
	newProject(Formats.free); Modes.options.edit.select();
	BarItems.import_obj.click();
	let dialog = Dialog.open; if (!dialog || dialog.id != 'import_obj') return JSON.stringify({no_dialog: true});
	dialog.onConfirm({obj: {content: ${JSON.stringify(obj)}}, scale: 1});
	dialog.hide();
	let mesh = Mesh.all[0];
	// drawn area of a face as Blockbench draws it (sorted corners), its normal, and whether a quad turns only one way
	let drawn = f => { let v = f.getSortedVertices().map(k => new THREE.Vector3().fromArray(mesh.vertices[k])); let a = 0; for (let i = 1; i + 1 < v.length; i++) a += new THREE.Vector3().subVectors(v[i], v[0]).cross(new THREE.Vector3().subVectors(v[i + 1], v[0])).length() / 2; return a; };
	let convex = f => { let v = f.getSortedVertices().map(k => mesh.vertices[k]); let s = 0; for (let i = 0; i < v.length; i++) { let a = v[i], b = v[(i + 1) % v.length], c = v[(i + 2) % v.length]; let t = (b[0] - a[0]) * (c[2] - b[2]) - (b[2] - a[2]) * (c[0] - b[0]); if (Math.abs(t) < 1e-9) return false; if (s == 0) s = Math.sign(t); else if (Math.sign(t) != s) return false; } return true; };
	let shapes = ${JSON.stringify(shapes)}, out = {};
	for (let name in shapes) {
		let {at, xz} = shapes[name];
		let faces = Object.values(mesh.faces).filter(f => f.vertices.every(k => mesh.vertices[k][0] >= at - 1e-6 && mesh.vertices[k][0] <= at + 3 + 1e-6));
		out[name] = {pieces: faces.map(f => f.vertices.length), area: +faces.reduce((a, f) => a + drawn(f), 0).toFixed(6),
			corners: new Set(faces.flatMap(f => f.vertices)).size, convex: faces.every(convex), min_area: +Math.min(...faces.map(drawn)).toFixed(6),
			up: faces.every(f => new THREE.Vector3().fromArray(f.getNormal()).normalize().y > 0.99), uv_kept: faces.every(f => f.vertices.every(k => f.uv[k] && !isNaN(f.uv[k][0])))};
	}
	return JSON.stringify({...out, faces: Object.keys(mesh.faces).length, undo: Undo.history[Undo.history.length - 1]?.action, entries: Undo.history.length});
})()`);
check('import dialog found', !result.no_dialog, result);
for (let [name, shape] of Object.entries(shapes)) {
	let r = result[name], expected = +shoelace(shape.xz).toFixed(6);
	check(`${name}: drawn area ${r.area} equals the polygon's ${expected}, every corner kept, every piece convex with area`, Math.abs(r.area - expected) < 1e-5 && r.corners == shape.xz.length && r.convex && r.min_area > 1e-6, r);
	check(`   faces up, uvs kept (${r.pieces.length} pieces: ${r.pieces.join(', ')})`, r.up && r.uv_kept, r);
}
check('the dart is two triangles, the midpoint rectangle holds its middle corner in no quad with a straight side', JSON.stringify(result.dart.pieces.slice().sort()) == '[3,3]' && result.midpoint.convex, result);
check('one undo entry for the import', result.undo == 'Import OBJ', result);

// The house: the drawn area of every face summed equals the file's polygon area summed (Newell), which the old fan
// overshot on 72 polygons; no face without area; every vertex of the file used by some face
if (fs.existsSync(HOUSE)) {
	const text = fs.readFileSync(HOUSE, 'utf8');
	let V = [], polygons = [];
	for (let line of text.split('\n')) { let p = line.trim().split(/\s+/); if (p[0] == 'v') V.push(p.slice(1, 4).map(Number)); else if (p[0] == 'f') polygons.push(p.slice(1).map(t => parseInt(t.split('/')[0]) - 1)); }
	let file_area = 0, fan_area = 0, ngons = 0;
	for (let poly of polygons) {
		let pts = poly.map(i => V[i]), n = [0, 0, 0];
		for (let i = 0; i < pts.length; i++) { let a = pts[i], b = pts[(i + 1) % pts.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); }
		file_area += Math.hypot(...n) / 2;
		if (pts.length > 4) ngons++;
		let tri = (a, b, c) => { let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2; };
		for (let i = 1; i + 1 < pts.length; i++) fan_area += tri(pts[0], pts[i], pts[i + 1]);	// what a fan from the first corner draws
	}
	const t0 = Date.now();
	const house = await json(`(async () => {
		newProject(Formats.free); Modes.options.edit.select();
		BarItems.import_obj.click(); let dialog = Dialog.open; dialog.onConfirm({obj: {content: ${JSON.stringify(text)}}, scale: 1}); dialog.hide();
		let area = 0, faces = 0, empty = 0, used = 0, vertices = 0;
		for (let mesh of Mesh.all) {
			let keys = new Set();
			for (let fkey in mesh.faces) { let f = mesh.faces[fkey]; let v = f.getSortedVertices().map(k => new THREE.Vector3().fromArray(mesh.vertices[k])); let a = 0; for (let i = 1; i + 1 < v.length; i++) a += new THREE.Vector3().subVectors(v[i], v[0]).cross(new THREE.Vector3().subVectors(v[i + 1], v[0])).length() / 2; area += a; faces++; if (a < 1e-9) empty++; f.vertices.forEach(k => keys.add(k)); }
			used += keys.size; vertices += Object.keys(mesh.vertices).length;
		}
		return JSON.stringify({area, faces, empty, used, vertices, meshes: Mesh.all.length});
	})()`);
	console.log(`   house: ${polygons.length} polygons (${ngons} n-gons) in ${Date.now() - t0} ms; file area ${file_area.toFixed(3)}, drawn ${house.area.toFixed(3)}, the old fan would draw ${fan_area.toFixed(3)}`);
	check('the house: the drawn area equals the file\'s polygon area within 0.1 percent (the fan overshot it), no empty face, every vertex used', Math.abs(house.area - file_area) / file_area < 1e-3 && fan_area / file_area > 1.01 && house.empty == 0 && house.used == house.vertices, {...house, file_area, fan_area});
} else {
	console.log('SKIP the house: file missing', HOUSE);
}

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
ws.close();
