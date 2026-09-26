// Pose Preview on the user's cat (skipped without the file): the weight brush's Pose Preview toggle shows a panel with the
// rig in the chosen animation's first frame, textured, drawn by its own renderer and camera. A: the toggle opens the panel,
// its dropdown lists the animations, it draws pixels. B: for every animation the panel's mesh equals the Animate tab's at
// that frame. C: the main scene is left at rest (geometry and bones). D: a real brush stroke in the main viewport changes
// the panel's mesh, still equal to the stock skinning of the new weights. E: a real drag and wheel on the panel turn and
// zoom its own camera and leave the main one alone. F: the toggle off hides the panel. The old hold-O is gone.
import assert from 'assert';
import fs from 'fs';
const FILE = 'D:/Work/CatWhisperer/models_working/cat_common.bbmodel';
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

if (!fs.existsSync(FILE)) {
	console.log('SKIP: ' + FILE + ' not found');
} else {
	await ev(`(() => { loadModelFile({content: ${JSON.stringify(fs.readFileSync(FILE, 'utf8'))}, path: ${JSON.stringify(FILE)}}); return true; })()`);
	await sleep(5000);
	const a = await json(`(async () => {
		Modes.options.edit.select(); window.body = Mesh.all.find(m => m.name == 'body');
		unselectAllElements(); ArmatureBone.all.find(b => b.name == 'spine_2').select(); updateSelection(); BarItems.weight_brush.select();
		for (let [id, v] of [['slider_weight_brush_size', 80], ['slider_weight_brush_strength', 20], ['slider_weight_brush_falloff', 20], ['slider_weight_brush_limit', 100]]) BarItems[id]?.setValue(v);
		BarItems.weight_brush_blend_mode.set('set'); if (BarItems.weight_brush_smooth?.value) BarItems.weight_brush_smooth.trigger(); BarItems.weight_brush_mirror?.set('off');
		let p = Preview.selected; p.setProjectionMode(false); p.camera.position.set(90, 45, 10); p.controls.target.set(0, 38, -8); p.controls.update(); p.render();
		window.restPos = () => Array.from(body.mesh.geometry.attributes.position.array);
		window.bonePose = () => ArmatureBone.all.map(b => b.scene_object.quaternion.toArray().concat(b.scene_object.position.toArray()));
		window.maxDiff = (x, y) => { let d = 0; for (let i = 0; i < x.length; i++) d = Math.max(d, Math.abs(x[i] - y[i])); return x.length == y.length ? d : Infinity; };
		Canvas.updateView({elements: Mesh.all, element_aspects: {geometry: true}});
		window.__rest = restPos(); window.__bones = bonePose();
		if (!BarItems.dew_pose_preview.value) BarItems.dew_pose_preview.trigger();
		await new Promise(r => setTimeout(r, 300));
		let panel = Panels.dew_pose_preview, c = DEWPosePreview.canvas;
		// the panel's world position of each body vertex
		window.previewWorld = () => { let copy = DEWPosePreview.state.copies.get(body), arr = copy.object.geometry.attributes.position.array, out = {};
			for (let [vkey, slots] of copy.slots) out[vkey] = new THREE.Vector3(arr[slots[0]*3], arr[slots[0]*3+1], arr[slots[0]*3+2]).applyMatrix4(copy.object.matrix).toArray(); return out; };
		window.worst = (a, b) => { let w = 0; for (let k in a) w = Math.max(w, Math.hypot(a[k][0]-b[k][0], a[k][1]-b[k][1], a[k][2]-b[k][2])); return +w.toFixed(5); };
		DEWPosePreview.state.view_dirty = true; DEWPosePreview.update();
		let gl = DEWPosePreview.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
		let drawn = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 0) drawn++;
		let options = Array.from(panel.node.querySelectorAll('select option')).map(o => o.textContent.trim());
		return JSON.stringify({shown: !!c && c.isConnected && c.clientWidth > 0, size: [c.clientWidth, c.clientHeight], options, animations: Animation.all.map(x => x.name), drawn: +(drawn / (w * h)).toFixed(3), copies: DEWPosePreview.state.copies.size,
			on_toolbar: Toolbars.weight_brush.children.some(x => x && x.id == 'dew_pose_preview'), old_gone: !BarItems.dew_pose_test && !window.DEWPoseTest}); })()`);
	check('A. the toggle opens the panel with every animation listed, and it draws the rig', a.shown && a.options.join() == a.animations.join() && a.drawn > 0.02 && a.copies >= 1 && a.on_toolbar && a.old_gone, a);

	// B. every animation against the Animate tab at its first key (the reference the user compares with)
	const b = await json(`(async () => {
		let out = [];
		let animateWorld = () => { let pos = body.mesh.geometry.attributes.position.array, out = {}, slot = 0; body.mesh.updateMatrixWorld(true);
			for (let f of Object.values(body.faces)) { if (f.vertices.length != 3 && f.vertices.length != 4) continue; for (let v of f.vertices) { if (!out[v]) out[v] = body.mesh.localToWorld(new THREE.Vector3(pos[slot*3], pos[slot*3+1], pos[slot*3+2])).toArray(); slot++; } } return out; };
		for (let anim of Animation.all) {
			let times = []; for (let id in anim.animators) for (let ch of ['rotation','position','scale']) anim.animators[id][ch]?.forEach(k => times.push(k.time)); let first = times.length ? Math.min(...times) : 0;
			Modes.options.animate.select(); anim.select(); Animation.all.forEach(a => a.playing = (a == anim)); Timeline.setTime(first); Animator.preview(); await new Promise(r => setTimeout(r, 100));
			let animate = animateWorld();
			Modes.options.edit.select(); unselectAllElements(); ArmatureBone.all.find(b => b.name == 'spine_2').select(); updateSelection(); BarItems.weight_brush.select(); await new Promise(r => setTimeout(r, 150));
			DEWPosePreview.setAnimation(anim.uuid); DEWPosePreview.update();
			out.push({name: anim.name, worst: worst(previewWorld(), animate)});
		}
		return JSON.stringify(out); })()`);
	console.log('   panel against the Animate tab, worst vertex (units):', b.map(r => r.name + ' ' + r.worst).join(', '));
	check('B. for every animation the panel matches the Animate tab at its first key', b.length > 0 && b.every(r => r.worst < 1e-3), b);

	const c = await json(`(() => { Canvas.updateView({elements: Mesh.all, element_aspects: {geometry: true}}); DEWPosePreview.markAll(); DEWPosePreview.update();
		return JSON.stringify({geometry: maxDiff(__rest, restPos()), bones: maxDiff(__bones.flat(), bonePose().flat())}); })()`);
	check('C. the main scene stays at rest while the panel shows the pose', c.geometry < 1e-6 && c.bones < 1e-9, c);

	// D. a real stroke in the main viewport: the panel follows, and equals the stock skinning of the new weights
	const aim = await json(`(() => { let p = Preview.selected; p.render(); let r = p.canvas.getBoundingClientRect(), q = body.getWorldCenter().project(p.camera);
		let x = r.left + (q.x + 1) / 2 * r.width, y = r.top + (1 - q.y) / 2 * r.height, pr = Panels.dew_pose_preview.node.getBoundingClientRect();
		window.__before = previewWorld(); window.__skins = DEWPosePreview.stats.skins;
		return JSON.stringify({x, y, clear_of_panel: !(x > pr.left - 60 && x < pr.right + 60 && y > pr.top - 60 && y < pr.bottom + 60)}); })()`);
	await mouse('mouseMoved', aim.x - 40, aim.y, {buttons: 0}); await sleep(80);
	await mouse('mousePressed', aim.x - 40, aim.y, {buttons: 1}); await sleep(60);
	for (let k = -40; k <= 40; k += 8) { await mouse('mouseMoved', aim.x + k, aim.y, {buttons: 1}); await sleep(60); }
	const mid = await json(`(() => { DEWPosePreview.update(); return JSON.stringify({moved: worst(previewWorld(), __before), skins: DEWPosePreview.stats.skins - __skins}); })()`);
	await mouse('mouseReleased', aim.x + 40, aim.y, {buttons: 0}); await sleep(300);
	const d = await json(`(() => { DEWPosePreview.update(); let shown = previewWorld();
		// reference: the real bones posed, the stock skinning of the current weights, the rest put back
		let anim = Animation.all.find(a => a.uuid == DEWPosePreview.state.animation_uuid), times = [];
		for (let id in anim.animators) for (let ch of ['rotation','position','scale']) anim.animators[id][ch]?.forEach(k => times.push(k.time));
		let t = Timeline.time; Animator.showDefaultPose(true); Timeline.time = times.length ? Math.min(...times) : 0; Animator.stackAnimations([anim], false); Canvas.scene.updateMatrixWorld(true);
		let offsets = DEWPerf.stockCalculateVertexDeformation.call(body.getArmature(), body), ref = {};
		body.mesh.updateMatrixWorld(true); for (let v in body.vertices) ref[v] = body.mesh.localToWorld(new THREE.Vector3().fromArray(body.vertices[v].slice().V3_add(offsets[v]))).toArray();
		Timeline.time = t; Animator.showDefaultPose(true); Canvas.scene.updateMatrixWorld(true);
		return JSON.stringify({changed: worst(shown, __before), against_stock: worst(shown, ref), undo: Undo.history.at(-1)?.action}); })()`);
	check('D. a real stroke updates the panel while painting and after, equal to the stock skinning of the new weights', aim.clear_of_panel && mid.moved > 0.01 && mid.skins > 0 && d.changed > 0.01 && d.against_stock < 1e-3, {aim, mid, d});
	await ev(`(() => { if (Undo.history.at(-1)?.action == 'Paint vertex weights') Undo.undo(); return true; })()`);

	// E. the panel's own camera: a real drag orbits it, the wheel zooms it, the main camera does not move
	const e0 = await json(`(() => { let r = DEWPosePreview.canvas.getBoundingClientRect(); window.__main = Preview.selected.camera.position.toArray().concat(Preview.selected.controls.target.toArray());
		return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2, yaw: DEWPosePreview.orbit.yaw, distance: DEWPosePreview.orbit.distance}); })()`);
	await mouse('mouseMoved', e0.x, e0.y, {buttons: 0});
	await mouse('mousePressed', e0.x, e0.y, {buttons: 1});
	for (let k = 1; k <= 5; k++) { await mouse('mouseMoved', e0.x + k * 12, e0.y, {buttons: 1}); await sleep(30); }
	await mouse('mouseReleased', e0.x + 60, e0.y, {buttons: 0});
	await send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: e0.x, y: e0.y, deltaX: 0, deltaY: 120}); await sleep(100);
	const e = await json(`(() => JSON.stringify({yaw: DEWPosePreview.orbit.yaw, distance: DEWPosePreview.orbit.distance, main: maxDiff(__main, Preview.selected.camera.position.toArray().concat(Preview.selected.controls.target.toArray())), weights_undo: Undo.history.at(-1)?.action}))()`);
	check('E. a drag on the panel orbits its own camera and the wheel zooms it, the main camera stays put', Math.abs(e.yaw - e0.yaw) > 0.3 && e.distance > e0.distance * 1.05 && e.main < 1e-9, {e0, e});

	const f = await json(`(() => { BarItems.dew_pose_preview.trigger(); let c = DEWPosePreview.canvas; return JSON.stringify({value: BarItems.dew_pose_preview.value, visible: c.clientWidth > 0 && c.isConnected}); })()`);
	check('F. the toggle off hides the panel', !f.value && !f.visible, f);
}

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
