// OBJ import keeps every corner of an n-gon: a face with more than four corners is fanned into quads and a last
// triangle covering the whole polygon. Stock kept the first four corners only, which left a hole beside every n-gon
// (the user's chair from Blender had four 7-gons and was missing faces).
import assert from 'assert';
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

// A regular heptagon in the XZ plane facing up (area 7/2 * r^2 * sin(2pi/7) at r 1), a unit quad and a triangle beside it
const R = 1, hept = [...Array(7)].map((_, i) => [Math.cos(i / 7 * Math.PI * 2) * R, 0, Math.sin(i / 7 * Math.PI * 2) * R]);
const obj = [
	'# fixture', 'o ngons',
	...hept.map(v => `v ${v[0]} ${v[1]} ${v[2]}`),
	'v 3 0 0', 'v 4 0 0', 'v 4 0 1', 'v 3 0 1',
	'v 6 0 0', 'v 7 0 0', 'v 6 0 1',
	...hept.map((_, i) => `vt ${(Math.cos(i / 7 * Math.PI * 2) + 1) / 2} ${(Math.sin(i / 7 * Math.PI * 2) + 1) / 2}`),
	'vn 0 1 0',
	'f ' + hept.map((_, i) => `${i + 1}/${i + 1}/1`).join(' '),	// listed counter-clockwise seen from above: with +Y up that is a downward winding, the normal line flips it
	'f 8//1 9//1 10//1 11//1',
	'f 12//1 13//1 14//1',
].join('\n');
const hept_area = 7 / 2 * R * R * Math.sin(2 * Math.PI / 7);

const result = await json(`(async () => {
	newProject(Formats.free); Modes.options.edit.select();
	BarItems.import_obj.click();
	let dialog = Dialog.open; if (!dialog || dialog.id != 'import_obj') return JSON.stringify({no_dialog: true});
	dialog.onConfirm({obj: {content: ${JSON.stringify(obj)}}, scale: 1});
	dialog.hide();
	let mesh = Mesh.all[0];
	let faces = Object.values(mesh.faces);
	let area = f => { let v = f.getSortedVertices().map(k => new THREE.Vector3().fromArray(mesh.vertices[k])); let a = 0; for (let i = 1; i + 1 < v.length; i++) a += new THREE.Vector3().subVectors(v[i], v[0]).cross(new THREE.Vector3().subVectors(v[i + 1], v[0])).length() / 2; return a; };
	let hept_faces = faces.filter(f => f.vertices.every(k => Math.hypot(mesh.vertices[k][0], mesh.vertices[k][2]) < 1.001 && Math.abs(mesh.vertices[k][1]) < 1e-6 && mesh.vertices[k][0] < 2));
	let normals_up = hept_faces.every(f => new THREE.Vector3().fromArray(f.getNormal()).normalize().y > 0.99);
	let uv_kept = hept_faces.every(f => f.vertices.every(k => f.uv[k] && f.uv[k].length == 2 && !isNaN(f.uv[k][0])));
	// each corner of the heptagon is used by exactly the pieces that touch it, and no corner was dropped
	let corners = new Set(hept_faces.flatMap(f => f.vertices));
	let detail = hept_faces.map(f => ({order: f.vertices.map(k => mesh.vertices[k].map(v => +v.toFixed(2))), normal: f.getNormal().map(v => +v.toFixed(2)), area: +area(f).toFixed(3)}));
	return JSON.stringify({detail, faces: faces.length, vertices: Object.keys(mesh.vertices).length, hept_pieces: hept_faces.map(f => f.vertices.length), hept_area: +hept_faces.reduce((a, f) => a + area(f), 0).toFixed(6), expected_area: +${hept_area}.toFixed(6), corners: corners.size, normals_up, uv_kept,
		undo: Undo.history[Undo.history.length - 1]?.action});
})()`);
check('A. the 7-gon came in as three pieces (quad, quad, triangle) using all seven corners', !result.no_dialog && JSON.stringify(result.hept_pieces) == '[4,4,3]' && result.corners == 7, result);
check('   covering exactly the polygon\'s area, no hole and no overlap', Math.abs(result.hept_area - result.expected_area) < 1e-4, result);
check('   facing the way the file\'s normal says, with the uvs of every corner kept', result.normals_up && result.uv_kept, result);
check('B. the quad and the triangle beside it are untouched: 5 faces and 14 vertices in all, one undo entry', result.faces == 5 && result.vertices == 14 && result.undo == 'Import OBJ', result);

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
