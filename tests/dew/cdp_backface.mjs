import fs from 'fs';
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type == 'page' && t.url.includes('index.html')) ?? targets.find(t => t.type == 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => { const m = JSON.parse(e.data);
	if (m.method == 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
	if (m.method == 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) errors.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 400));
	if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result.result.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { if (await ev('typeof Blockbench != "undefined" && !!window.Preview && Preview.all.length > 0')) break; await sleep(500); }
await send('Runtime.enable');

// One 32x32 floor quad facing up, a textured copy beside it, and a sampler that renders and reads the pixel at a world point
await ev(`(() => {
	window.__quad = (name, x0) => { let m = new Mesh({name, vertices: {}}); let k = [[x0,0,0],[x0+32,0,0],[x0+32,0,32],[x0,0,32]].map(v => m.addVertices(v)[0]);
		let f = new MeshFace(m, {vertices: k, texture: false}); m.addFaces(f); if (f.getNormal(true)[1] < 0) f.invert(); m.init(); return m; };
	window.__sample = (camera_y, x) => { let p = Preview.selected; p.controls.target.set(x, 0, 16); p.camera.position.set(x, camera_y, 70); p.controls.update();
		if (p.render) p.render(); else p.renderer.render(scene, p.camera);
		let gl = p.renderer.getContext(); let v = new THREE.Vector3(x, 0, 16).project(p.camera);
		let px = new Uint8Array(4); gl.readPixels(Math.round((v.x + 1) / 2 * gl.drawingBufferWidth), Math.round((v.y + 1) / 2 * gl.drawingBufferHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
		return Array.from(px.slice(0, 3)); };
	return true; })()`);

const setup = `(() => { let a = __quad('plain', 0); let b = __quad('textured', 48);
	let t = new Texture({name: 'probe'}).add(false); Object.values(b.faces).forEach(f => f.texture = t.uuid);
	Canvas.updateView({elements: [a, b], element_aspects: {faces: true}}); unselectAllElements(); return t.uuid; })()`;

console.log('A. DEW scene:', await ev(`(() => { newProject(Formats.dew_scene); ${setup}; let u = Canvas.backfaceUniforms;
	let t = Texture.all[0];
	return JSON.stringify({tint: u.BACKFACE_TINT.value, color: '#' + u.BACKFACE_COLOR.value.getHexString(),
		shared: {texture: t.material.uniforms.BACKFACE_TINT === u.BACKFACE_TINT, marker: Canvas.emptyMaterials[0].uniforms.BACKFACE_TINT === u.BACKFACE_TINT,
		colored_solid: Canvas.coloredSolidMaterials[0].uniforms.BACKFACE_TINT === u.BACKFACE_TINT, mono_solid: Canvas.monochromaticSolidMaterial.uniforms.BACKFACE_TINT === u.BACKFACE_TINT,
		flat: Canvas.getFlatColorMaterial('#cc3322').uniforms.BACKFACE_TINT === u.BACKFACE_TINT}}); })()`));
await sleep(300);
console.log('   plain quad from above / below:', JSON.stringify(await ev('__sample(60, 16)')), JSON.stringify(await ev('__sample(-60, 16)')));
console.log('   textured quad from above / below:', JSON.stringify(await ev('__sample(60, 64)')), JSON.stringify(await ev('__sample(-60, 64)')));
console.log('   target color #2a3348 = [42, 51, 72]; below should sit near it (85% tint)');
await ev('__sample(-60, 40)');
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot_backface.png', Buffer.from(shot.result.data, 'base64'));

console.log('B. Generic scene:', await ev(`(() => { newProject(Formats.free); ${setup}; return JSON.stringify({tint: Canvas.backfaceUniforms.BACKFACE_TINT.value}); })()`));
await sleep(300);
console.log('   plain quad from above / below:', JSON.stringify(await ev('__sample(60, 16)')), JSON.stringify(await ev('__sample(-60, 16)')), ' expect below ~ above (no tint)');

console.log('C. back to DEW tab:', await ev(`(() => { ModelProject.all.find(p => p.format.id == 'dew_scene').select(); return Canvas.backfaceUniforms.BACKFACE_TINT.value; })()`));
console.log('page errors/warnings:', errors.length ? errors : 'none');
ws.close();
