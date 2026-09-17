// Select Linked (L) and Separate Loose Parts (Alt + L): a base box with three slat boxes in one mesh, the slats with
// vertices of their own resting on the base.
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
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); if (!ok) failures++; };

const setup = `(() => {
	newProject(Formats.free);
	let m = new Mesh({name: 'crate', vertices: {}});
	function box(from, to, split) {
		let v = {};
		let xs = split ? [from[0], (from[0] + to[0]) / 2, to[0]] : [from[0], to[0]];
		for (let x of xs) for (let y of [from[1], to[1]]) for (let z of [from[2], to[2]]) v[[x, y, z]] = m.addVertices([x, y, z])[0];
		let q = (a, b, c, d) => m.addFaces(new MeshFace(m, {vertices: [v[a], v[b], v[c], v[d]]}));
		let [y0, y1, z0, z1] = [from[1], to[1], from[2], to[2]];
		for (let i = 0; i < xs.length - 1; i++) {
			let [x0, x1] = [xs[i], xs[i + 1]];
			q([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]); q([x0,y1,z0],[x0,y1,z1],[x1,y1,z1],[x1,y1,z0]);
			q([x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[x1,y0,z0]); q([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]);
		}
		let [xa, xb] = [xs[0], xs[xs.length - 1]];
		q([xa,y0,z0],[xa,y0,z1],[xa,y1,z1],[xa,y1,z0]); q([xb,y0,z0],[xb,y1,z0],[xb,y1,z1],[xb,y0,z1]);
	}
	box([-40, 0, -24], [40, 4, 24], true);	// base: 10 faces, the largest part
	box([-30, 4, -20], [-26, 8, 20]);
	box([-2, 4, -20], [2, 8, 20]);
	box([26, 4, -20], [30, 8, 20]);
	m.init();
	Canvas.updateAll();
	unselectAllElements();
	BarItems.selection_mode.set('object'); BarItems.selection_mode.onChange(BarItems.selection_mode);
	let p = Preview.selected;
	p.camera.position.set(0, 90, 70); p.controls.target.set(0, 0, 0); p.camera.lookAt(0, 0, 0); p.controls.update(); p.render();
	return Object.keys(m.faces).length;
})()`;
const faces = await ev(setup);
await sleep(200);
check('A. four loose parts found', await ev(`JSON.stringify(DEWLinked.looseParts(Mesh.all[0]).map(p => p.length).sort((a, b) => b - a))`) == '[10,6,6,6]', {faces});

// Screen point of the middle slat's top, in page CSS pixels
const screenOf = pt => ev(`(() => { let p = Preview.selected; p.render(); p.camera.updateMatrixWorld(); let s = new THREE.Vector3(${pt}).project(p.camera); let r = p.canvas.getBoundingClientRect(); return [r.left + (s.x + 1) / 2 * p.width, r.top + (1 - s.y) / 2 * p.height]; })()`);
const [sx, sy] = await screenOf('0, 8, 0');
await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: sx, y: sy});
await sleep(50);
await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76});
await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76});
await sleep(100);
const sel = `(() => { let m = Mesh.all[0]; let f = m.getSelectedFaces(); let xs = f.flatMap(k => m.faces[k].vertices.map(v => m.vertices[v][0])); return {mesh_selected: m.selected, mode: BarItems.selection_mode.value, faces: f.length, vertices: m.getSelectedVertices().length, x: [Math.min(...xs), Math.max(...xs)]}; })()`;
const b = await ev(sel);
check('B. L over the middle slat selects its 6 faces and 8 vertices, face mode', b.mesh_selected && b.mode == 'face' && b.faces == 6 && b.vertices == 8 && b.x[0] == -2 && b.x[1] == 2, b);

// Pointer off the canvas: L completes the part of a face already selected, keeping the rest
await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: 2, y: 2});
await ev(`(() => { let m = Mesh.all[0]; let fkey = Object.keys(m.faces).find(k => m.faces[k].vertices.every(v => m.vertices[v][0] >= 26 && m.vertices[v][1] >= 4)); m.getSelectedFaces(true).push(fkey); m.getSelectedVertices(true).push(...m.faces[fkey].vertices); updateSelection(); return true; })()`);
await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76});
await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76});
await sleep(100);
const c = await ev(sel);
check('C. L off the canvas completes the right slat and keeps the middle one', c.faces == 12 && c.vertices == 16 && c.x[0] == -2 && c.x[1] == 30, c);

// Separate with the real Alt + L
await send('Input.dispatchKeyEvent', {type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 1});
await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, modifiers: 1});
await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, modifiers: 1});
await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18});
await sleep(150);
const d = await ev(`JSON.stringify(Mesh.all.map(m => ({name: m.name, faces: Object.keys(m.faces).length, vertices: Object.keys(m.vertices).length, selected: m.selected, x: (xs => [Math.min(...xs), Math.max(...xs)])(Object.values(m.vertices).map(v => v[0] + m.origin[0]))})))`);
const parts = JSON.parse(d);
const byName = Object.fromEntries(parts.map(p => [p.name, p]));
check('D. Alt + L makes four objects, the base keeps the name', parts.length == 4 && byName.crate?.faces == 10 && byName.crate?.vertices == 12 && ['crate_2', 'crate_3', 'crate_4'].every(n => byName[n]?.faces == 6 && byName[n]?.vertices == 8), parts);
check('   all four selected, geometry in place', parts.every(p => p.selected) && parts.map(p => p.x.join()).sort().join('|') == ['-2,2', '-30,-26', '-40,40', '26,30'].sort().join('|'));
check('   outliner order: base first, parts after it', await ev(`JSON.stringify(Outliner.root.filter(n => n instanceof Mesh).map(n => n.name))`) == '["crate","crate_2","crate_3","crate_4"]', await ev(`JSON.stringify(Outliner.root.map(n => n.name))`));

await ev(`(() => { Undo.undo(); return true; })()`);
await sleep(100);
check('E. one undo puts the single mesh back', await ev(`Mesh.all.length == 1 && Object.keys(Mesh.all[0].faces).length == 28 && Object.keys(Mesh.all[0].vertices).length == 36`) === true, await ev(`Mesh.all.map(m => m.name + ':' + Object.keys(m.faces).length)`));

// F. a part mesh has one part, so separating it again changes nothing
await ev(setup);
await ev(`(() => { let n = DEWLinked.separateLooseParts([Mesh.all.find(m => m.name == 'crate')]); return true; })()`);
check('F. a part mesh passed again stays one object', await ev(`(() => { let m = Mesh.all.find(m => m.name == 'crate_2'); return DEWLinked.separateLooseParts([m]) === 0 && Mesh.all.length == 4; })()`) === true);

check('G. keybinds L and Alt + L', await ev(`BarItems.dew_select_linked.keybind.getText() + ' / ' + BarItems.dew_separate_loose_parts.keybind.getText()`) == 'L / Alt + L', await ev(`BarItems.dew_select_linked.keybind.getText() + ' / ' + BarItems.dew_separate_loose_parts.keybind.getText()`));
check('   in the Mesh menu', await ev(`(() => { let s = JSON.stringify(MenuBar.menus.mesh.structure); return s.includes('dew_select_linked') && s.includes('dew_separate_loose_parts'); })()`) === true);

console.log('page errors:', errors.length ? errors : 'none');
console.log(failures ? `${failures} FAILED` : 'all passed');
ws.close();
