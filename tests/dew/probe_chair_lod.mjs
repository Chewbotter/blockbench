// Opens a bbmodel (PROBE_FILE), prints elements, triangle count, outward-facing check, and saves screenshots with back faces culled.
import fs from 'fs';
const file = process.env.PROBE_FILE;
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

const content = fs.readFileSync(file, 'utf8');
console.log(await ev(`(() => {
	let json = ${JSON.stringify(content)};
	loadModelFile({content: json, path: ${JSON.stringify(file)}});
	return JSON.stringify({format: Format.id, elements: Outliner.elements.length, textures: Texture.all.length});
})()`));
await sleep(800);
console.log(await ev(`(() => {
	let out = [];
	let total = 0;
	for (let m of Mesh.all) {
		let tris = 0;
		for (let f of Object.values(m.faces)) tris += f.vertices.length - 2;
		total += tris;
		out.push(m.name + ' ' + tris);
	}
	updateSelection();
	return JSON.stringify({parts: out, total, status: Interface.status_bar.vue.poly_info, groups: Group.all.map(g => g.name + ':' + g.children.length)});
})()`));

// Inward faces: cast from the face centre along its normal a short way out; a face whose normal points into its own part
// hits that part's own geometry right away. Simple version: count faces whose normal points toward the part's centroid
// among parts that are convex (wheels, arms are boxes).
console.log(await ev(`(() => {
	let bad = [];
	for (let m of Mesh.all) {
		let keys = Object.keys(m.vertices);
		let c = [0,0,0]; keys.forEach(k => m.vertices[k].forEach((v, i) => c[i] += v / keys.length));
		let raycaster = new THREE.Raycaster();
		m.mesh.updateMatrixWorld();
		for (let [fk, f] of Object.entries(m.faces)) {
			let n = f.getNormal(true);
			let fc = f.getCenter();
			// ray from just outside the face going back inward must hit this face's front
			let world_c = m.mesh.localToWorld(new THREE.Vector3(...fc));
			let world_n = new THREE.Vector3(...n).transformDirection(m.mesh.matrixWorld);
			let start = world_c.clone().addScaledVector(world_n, 0.05);
			raycaster.set(start, world_n.clone().negate());
			raycaster.far = 0.2;
			let hit = raycaster.intersectObject(m.mesh, false)[0];
			if (hit && hit.face && hit.face.normal.dot(new THREE.Vector3(...n)) < 0) bad.push(m.name + ':' + fk);
		}
	}
	return JSON.stringify({flipped_faces_by_raycast: bad});
})()`));

// Screenshots with back faces culled, so a flipped face shows as a hole
await ev(`(() => { Texture.all.forEach(t => { t.render_sides = 'front'; }); Canvas.updateAllFaces(); Canvas.updateView({elements: Mesh.all, element_aspects: {faces: true}}); return true; })()`);
const shots = [[[120, 110, 140], 'a'], [[-140, 60, -120], 'b'], [[0, -120, 20], 'c']];
for (const [pos, tag] of shots) {
	await ev(`(() => { let p = Preview.selected || Preview.all[0]; p.camera.position.set(${pos}); p.controls.target.set(0, 50, 0); p.camera.lookAt(0, 50, 0); p.controls.update(); p.render(); return true; })()`);
	await sleep(300);
	await ev(`(() => { (Preview.selected || Preview.all[0]).render(); return true; })()`);
	const shot = await send('Page.captureScreenshot', { format: 'png' });
	const out = `${process.env.SHOT_DIR}/chair_${tag}.png`;
	fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
	console.log('shot', out);
}
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
