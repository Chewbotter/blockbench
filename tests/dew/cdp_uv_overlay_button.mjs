// Display All Elements (edit_mode_uv_overlay) is the first button of the UV toolbar, no longer alone in the slider
// row above it, and a customised toolbar from before (the user's stored uv_editor list) gains it at the front.
import assert from 'assert';
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type == 'page' && t.url.includes('index.html')) ?? targets.find(t => t.type == 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method == 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result.result.value; };
const json = async expr => JSON.parse(await ev(expr));
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { if (await ev('typeof Blockbench != "undefined" && !!window.Preview && Preview.all.length > 0')) break; await sleep(500); }
await send('Runtime.enable');
let passed = 0;
const check = (name, ok, detail) => { if (ok) { passed++; console.log('PASS', name); } else { console.log('FAIL', name, detail ?? ''); assert.ok(ok, name); } };

await ev(`(() => { newProject(Formats.free); new Cube({name: 'c', from: [0,0,0], to: [16,16,16]}).init().select(); if (Panels.uv.folded) Panels.uv.fold(false); updateSelection(); return true; })()`);
await sleep(500);

// A. first in the toolbar's own list, and the first button drawn in it; not in the slider row
const a = await json(`(() => { let bar = Toolbars.uv_editor, item = BarItems.edit_mode_uv_overlay; let content = document.querySelector('.toolbar_wrapper.uv_editor .toolbar .content'), slider_row = document.querySelector('.bar.uv_editor_sliders');
	let nodes = (item.nodes?.length ? item.nodes : [item.node]).filter(n => n.isConnected);	// toolbar nodes carry no id class, so they are told apart by identity
	return JSON.stringify({first_child: bar.children[0]?.id, first_drawn: nodes.includes(content?.firstElementChild), in_slider_row: nodes.some(n => slider_row?.contains(n)), drawn_once: nodes.length}); })()`);
check('A. Display All Elements leads the UV toolbar and has left the slider row', a.first_child == 'edit_mode_uv_overlay' && a.first_drawn === true && !a.in_slider_row && a.drawn_once == 1, a);

// B. clicking it there still switches the panel between selected elements and all
await ev(`(() => { settings.display_uv.set('selected_elements'); BarItems.edit_mode_uv_overlay.value = false; BarItems.edit_mode_uv_overlay.updateEnabledState(); return true; })()`);
const before = await ev(`settings.display_uv.value`);
await ev(`(() => { document.querySelector('.toolbar_wrapper.uv_editor .toolbar .content').firstElementChild.click(); return true; })()`); await sleep(200);
const mid = await json(`JSON.stringify({setting: settings.display_uv.value, vue: UVEditor.vue.display_uv, on: BarItems.edit_mode_uv_overlay.value})`);
await ev(`(() => { document.querySelector('.toolbar_wrapper.uv_editor .toolbar .content').firstElementChild.click(); return true; })()`); await sleep(200);
const after = await json(`JSON.stringify({setting: settings.display_uv.value, vue: UVEditor.vue.display_uv, on: BarItems.edit_mode_uv_overlay.value})`);
check('B. the button toggles all elements on and off from its new place', before == 'selected_elements' && mid.setting == 'all_elements' && mid.vue == 'all_elements' && mid.on && after.setting == 'selected_elements' && after.vue == 'selected_elements' && !after.on, {before, mid, after});

// C. a stored toolbar customisation from before this change (the user's exact list) gains the button at the front on rebuild
const c = await json(`(() => { let bar = Toolbars.uv_editor; let saved = BARS.stored.uv_editor, known = BARS.stored._known.slice();
	BARS.stored.uv_editor = ['move_texture_with_uv', 'uv_apply_all', 'uv_maximize', 'uv_project_from_view', 'uv_transparent', 'uv_rotation', 'toggle_mirror_uv', '_', 'auto_unwrap', 'uv_snap'];
	BARS.stored._known.remove('edit_mode_uv_overlay');
	bar.build({children: bar.default_children ?? bar.children_original ?? ['edit_mode_uv_overlay', 'move_texture_with_uv', 'uv_apply_all', 'uv_maximize', 'uv_auto', 'uv_project_from_view', 'uv_transparent', 'uv_mirror_x', 'uv_mirror_y', 'auto_unwrap', 'uv_snap', 'uv_rotation', 'toggle_mirror_uv']});
	let out = {first: bar.children[0]?.id, second: bar.children[1]?.id, count: bar.children.length};
	if (saved) BARS.stored.uv_editor = saved; else delete BARS.stored.uv_editor; BARS.stored._known = known; bar.build({children: ['edit_mode_uv_overlay', 'move_texture_with_uv', 'uv_apply_all', 'uv_maximize', 'uv_auto', 'uv_project_from_view', 'uv_transparent', 'uv_mirror_x', 'uv_mirror_y', 'auto_unwrap', 'uv_snap', 'uv_rotation', 'toggle_mirror_uv']});
	return JSON.stringify(out); })()`);
check('C. a toolbar customised before the change takes the button at the front', c.first == 'edit_mode_uv_overlay' && c.second == 'move_texture_with_uv' && c.count == 11, c);

console.log('page errors:', errors.length ? errors : 'none');
check('D. no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
ws.close();
