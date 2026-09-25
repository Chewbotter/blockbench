// Null objects (IK handles, poles) show and can be clicked in orthographic views. Stock sized their icon by camera.fov,
// which an orthographic camera does not have, so the scale was NaN and they vanished there. Checked: in perspective the
// scale is exactly the stock one; in ortho it is finite and the icon covers about as many pixels as in perspective, at
// two zoom levels; a real click on it in ortho selects it.
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
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });

await ev(`(() => {
	newProject(Formats.free); Modes.options.edit.select();
	let n = new NullObject({name: 'handle', position: [0, 8, 0]}).init(); unselectAllElements(); updateSelection(); Canvas.updateAll();
	window.handle = n;
	let p = Preview.selected; window.aim = (ortho, zoom) => { p.setProjectionMode(ortho); p.camera.position.set(30, 20, 40); p.controls.target.set(0, 8, 0); if (ortho) { p.camOrtho.zoom = zoom; p.camOrtho.updateProjectionMatrix(); } p.controls.update(); p.render(); };
	window.iconPixels = () => { let gl = p.renderer.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight; let grab = () => { p.render(); let b = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
		let a = grab(); n.mesh.visible = false; let b = grab(); n.mesh.visible = true; p.render(); let c = 0; for (let i = 0; i < a.length; i += 4) if (a[i] != b[i] || a[i + 1] != b[i + 1] || a[i + 2] != b[i + 2]) c++; return c; };
	window.screenOf = () => { let r = p.canvas.getBoundingClientRect(), q = n.mesh.getWorldPosition(new THREE.Vector3()).project(p.camera); return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height]; };
	return true;
})()`);

let pers = await json(`(() => { aim(false); let p = Preview.selected; return JSON.stringify({scale: handle.mesh.scale.x, stock: 0.38 * p.camPers.fov / p.height, pixels: iconPixels()}); })()`);
check('A. in perspective the icon keeps exactly the stock size', Math.abs(pers.scale - pers.stock) < 1e-9 && pers.pixels > 20, pers);
let ortho = await json(`(() => { let out = []; for (let z of [0.3, 1.2]) { aim(true, z); out.push({zoom: z, scale: handle.mesh.scale.x, pixels: iconPixels()}); } return JSON.stringify(out); })()`);
console.log('   perspective', pers.pixels, 'px; ortho', ortho.map(o => o.zoom + ': ' + o.pixels + ' px').join(', '));
check('B. in ortho the scale is finite and the icon is drawn, at both zoom levels', ortho.every(o => isFinite(o.scale) && o.scale > 0 && o.pixels > 20), ortho);
check('   about the same size on screen as in perspective (within 25 percent)', ortho.every(o => Math.abs(o.pixels - pers.pixels) <= pers.pixels * 0.25), {pers: pers.pixels, ortho});

await ev(`(() => { aim(true, 0.6); unselectAllElements(); updateSelection(); return true; })()`);
await sleep(200);
let [x, y] = await json(`JSON.stringify(screenOf())`);
for (let i = 0; i < 2; i++) { await mouse('mouseMoved', x, y, { button: 'none' }); await sleep(50); }
await mouse('mousePressed', x, y, { buttons: 1 }); await sleep(40); await mouse('mouseReleased', x, y); await sleep(200);
let picked = await json(`JSON.stringify(Outliner.selected.map(e => e.name))`);
check('C. a real click on it in an ortho view selects it', JSON.stringify(picked) == '["handle"]', picked);
await ev(`(() => { aim(false); return true; })()`);

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
