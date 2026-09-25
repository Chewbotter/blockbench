// Opening a file puts back the view it was saved in, orthographic included, and nothing overrides it afterwards.
// The old Fit View on Open (removed 2026-09-25 at the user's word, the saved view does the job) ran a tick after the
// restore, re-aimed every preview and turned an orthographic camera into NaN, so cat_common_backup.bbmodel opened blank
// but for its reference image. Also: a saved view holding nulls (written while a camera was NaN) is ignored on open,
// and a camera holding NaN is never saved.
import assert from 'assert';
import fs from 'fs';
const CAT = 'D:/Work/CatWhisperer/models_working/cat_common_backup.bbmodel';
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
const main = `(() => { let p = Preview.all.find(p => p.id == 'main'); let r = v => v.toArray().map(x => isFinite(x) ? +x.toFixed(3) : 'NaN'); return JSON.stringify({ortho: p.isOrtho, position: r(p.camera.position), target: r(p.controls.target), zoom: isFinite(p.camOrtho.zoom) ? +p.camOrtho.zoom.toFixed(4) : 'NaN'}); })()`;
const open = async (content, path) => { await ev(`(() => { loadModelFile({content: ${JSON.stringify(content)}, path: ${JSON.stringify(path)}}); return true; })()`); await sleep(800); return json(main); };

// A. a model saved in an orthographic view reopens in exactly that view, still so a moment later
const saved = await json(`(() => { newProject(Formats.free); Modes.options.edit.select();
	let m = new Mesh({name: 'block', vertices: {}}); let k = m.addVertices([0,0,0],[16,0,0],[16,16,0],[0,16,0],[0,0,16],[16,0,16],[16,16,16],[0,16,16]);
	[[0,1,2,3],[4,5,6,7],[0,1,5,4],[2,3,7,6],[0,3,7,4],[1,2,6,5]].forEach(q => m.addFaces(new MeshFace(m, {vertices: q.map(i => k[i])}))); m.init(); Canvas.updateAll();
	let p = Preview.all.find(p => p.id == 'main'); p.setProjectionMode(true); p.camera.position.set(70, 30, -2); p.controls.target.set(7, 26, -20); p.camOrtho.zoom = 0.14; p.camOrtho.updateProjectionMatrix(); p.controls.update(); p.render();
	return JSON.stringify({content: Codecs.project.compile(), view: JSON.parse(${main})}); })()`);
let a = await open(saved.content, 'D:/test/ortho_view.bbmodel');
await sleep(1000); let a_later = await json(main);
check('A. an orthographic view comes back as saved: position, target and zoom', a.ortho && JSON.stringify(a.position) == JSON.stringify(saved.view.position) && JSON.stringify(a.target) == JSON.stringify(saved.view.target) && Math.abs(a.zoom - saved.view.zoom) < 1e-3, {a, saved: saved.view});
check('   and a moment later nothing has re-aimed it', JSON.stringify(a_later) == JSON.stringify(a), {a, a_later});
check('   the Fit View on Open setting is gone', await ev(`!settings.fit_view_on_open`), null);

// B. a saved view holding nulls (the media entry of the cat's file, and here main too) is ignored: the camera stays sane
let broken = JSON.parse(saved.content);
broken.view.previews.main = {position: [null, null, null], target: [null, null, null], orthographic: true, zoom: null, angle: null};
broken.view.previews.media = {position: [null, null, null], target: [null, null, null], orthographic: false, zoom: 0.5, angle: null};
let b = await open(JSON.stringify(broken), 'D:/test/broken_view.bbmodel');
check('B. a view saved as nulls is ignored: the main camera opens on finite numbers', !JSON.stringify(b).includes('NaN'), b);

// C. a camera holding NaN is never written into the file
let c = await json(`(() => { let p = Preview.all.find(p => p.id == 'media'); p.camera.position.set(NaN, NaN, NaN); let out = JSON.parse(Codecs.project.compile()); p.camera.position.set(-40, 32, -40);
	return JSON.stringify({media_saved: !!(out.view && out.view.previews && out.view.previews.media), main_saved: !!(out.view && out.view.previews && out.view.previews.main)}); })()`);
check('C. a preview whose camera holds NaN is left out of the saved view, the good ones stay', !c.media_saved && c.main_saved, c);

// D. the user's file: opens with its own orthographic view and the model on screen
if (fs.existsSync(CAT)) {
	let d = await open(fs.readFileSync(CAT, 'utf8'), CAT);
	await sleep(1500);
	let shown = await json(`(() => { let p = Preview.all.find(p => p.id == 'main'); p.render(); let gl = p.renderer.getContext(); let W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
		let a = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, a); Mesh.all.forEach(m => m.mesh.visible = false); p.render(); let b = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b); Mesh.all.forEach(m => m.mesh.visible = true); p.render();
		let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] != b[i] || a[i + 1] != b[i + 1] || a[i + 2] != b[i + 2]) n++; return JSON.stringify({pixels_of_model: n, of: W * H}); })()`);
	check('D. cat_common_backup opens in its saved orthographic view with finite numbers', d.ortho && !JSON.stringify(d).includes('NaN'), d);
	check('   and the cat covers a real share of the viewport', shown.pixels_of_model > shown.of * 0.02, shown);
} else {
	console.log('SKIP D: ' + CAT + ' not found');
}

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
