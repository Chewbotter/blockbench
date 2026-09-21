// The rotate gizmo with a ring seen edge-on. The angle used to come from where the pointer's ray meets the ring's plane,
// and a ray grazing that plane lands anywhere, so the rotation jumped about. Edge-on rings are now dragged along the line
// they make on screen. Real drags, measured step by step, with the old behaviour (EDGE_ON_DEG 0) as the control.
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

await ev(`(() => { newProject(Formats.free); Modes.options.edit.select();
	window.cube = new Cube({name: 'box', from: [-4, 0, -4], to: [4, 8, 4], origin: [0, 4, 0]}).init(); cube.select();
	BarItems.rotate_tool.select(); BarItems.rotation_space.set('local'); updateSelection(); return true; })()`);
const lookFrom = async position => { await ev(`(() => { let p = Preview.selected; p.setProjectionMode(false); p.camera.position.set(${position}); p.controls.target.set(0, 4, 0); p.controls.update(); p.render(); Transformer.update(); p.render(); return true; })()`); await sleep(250); };
const gizmo = () => json(`(() => { let p = Preview.selected, r = p.canvas.getBoundingClientRect(); let c = Transformer.position.clone().add(scene.position), right = new THREE.Vector3(1, 0, 0).applyQuaternion(p.camera.quaternion);
	let a = c.clone().project(p.camera), b = c.clone().addScaledVector(right, Transformer.scale.x).project(p.camera);
	return JSON.stringify({x: r.left + (a.x + 1) / 2 * r.width, y: r.top + (1 - a.y) / 2 * r.height, radius: Math.abs(b.x - a.x) / 2 * r.width}); })()`);
// Hover outward from a start angle until the transformer reports the wanted ring
async function findRing(axis, centre, angles) {
	for (let fraction = 0.35; fraction <= 1.05; fraction += 0.05) for (let angle of angles) {
		let x = centre.x + Math.cos(angle) * centre.radius * fraction, y = centre.y + Math.sin(angle) * centre.radius * fraction;
		await mouse('mouseMoved', x, y, { button: 'none' }); await sleep(15);
		if (await ev(`Transformer.axis`) == axis) return {x, y};
	}
	return null;
}
// Press, move right in even steps, release; the cube's rotation about y after every step
async function dragRight(grab, pixels, steps, wobble = 0) {
	await ev(`(() => { cube.rotation.V3_set(0, 0, 0); Canvas.updateView({elements: [cube], element_aspects: {transform: true}}); Transformer.update(); return true; })()`);
	await mouse('mouseMoved', grab.x, grab.y, { button: 'none' }); await sleep(40);
	await mouse('mousePressed', grab.x, grab.y, { buttons: 1 }); await sleep(60);
	let mode = await ev(`!!Transformer.edge_on_rotate`), values = [], pressed = await ev(`JSON.stringify({axis: Transformer.axis, dragging: !!Transformer.dragging})`);
	for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', grab.x + pixels * i / steps, grab.y + (i % 2 ? wobble : -wobble), { buttons: 1 }); await sleep(35); values.push(await ev(`cube.rotation[1]`)); }
	await mouse('mouseReleased', grab.x + pixels, grab.y); await sleep(200);
	let deltas = values.map((v, i) => v - (i ? values[i - 1] : 0));
	return {edge_on: mode, pressed, rotation: await ev(`JSON.stringify(cube.rotation)`), values, deltas, total: values[values.length - 1], biggest_step: Math.max(...deltas.map(Math.abs)), reversals: deltas.filter((d, i) => i && d * deltas[i - 1] < 0).length};
}

// A. level with the gizmo, looking down z: the Y ring is a horizontal line on screen
await lookFrom('0, 4, 60');
let centre = await gizmo();
let grab = await findRing('Y', centre, [0, Math.PI]);
check('A. the edge-on Y ring can be grabbed', !!grab, centre);
let on = await dragRight(grab, 120, 12);
let expected = 120 / centre.radius * 180 / Math.PI;
console.log('   with the fix:', JSON.stringify({edge_on: on.edge_on, total: on.total, expected: Math.round(expected * 10) / 10, biggest_step: on.biggest_step, reversals: on.reversals}));
check('   an edge-on ring is dragged along its line: the turn is even, never reverses, and an arc of one radius per radius travelled', on.edge_on && on.reversals == 0 && Math.abs(Math.abs(on.total) - expected) < 6 && on.biggest_step < Math.abs(on.total) / 12 * 2.5 + 2.6, on);

await ev(`(() => { window.__edge = ROTATE_GIZMO.EDGE_ON_DEG; ROTATE_GIZMO.EDGE_ON_DEG = 0; return true; })()`);
let off = await dragRight(grab, 120, 12);
await ev(`(() => { ROTATE_GIZMO.EDGE_ON_DEG = window.__edge; return true; })()`);
console.log('   control, old behaviour:', JSON.stringify({edge_on: off.edge_on, values: off.values.map(v => Math.round(v * 10) / 10), biggest_step: off.biggest_step, reversals: off.reversals}));
check('   the control shows what it replaced: the plane reading is rougher or lost from the same gesture', !off.edge_on && (off.biggest_step > on.biggest_step * 1.5 || off.reversals > 0 || Math.abs(off.total) < Math.abs(on.total) / 3), {on_step: on.biggest_step, off_step: off.biggest_step, off_total: off.total, reversals: off.reversals});

// B. seen from above at an angle the ring is an open ellipse: the plane reading stays in charge, and the same gesture at
// the near side of the ring turns the same way as the edge-on drag did
await lookFrom('0, 50, 46');
centre = await gizmo();
// Off to one side of straight down: straight down, the X ring (edge-on from here, a vertical line) lies over the Y ring
let near = await findRing('Y', centre, [Math.PI / 3, Math.PI * 2 / 3]);
check('B. the open Y ring can be grabbed at its near side', !!near, centre);
let open = await dragRight(near, 60, 8);
check('   an open ring keeps the plane reading, and turns the same way for the same gesture', !open.edge_on && Math.sign(open.total) == Math.sign(on.total) && Math.abs(open.total) > 5, {...open, edge_on_total: on.total});

// C. near the threshold, just inside it: still even
await lookFrom('0, 16, 58');
centre = await gizmo();
let tilted = await findRing('Y', centre, [0, Math.PI, Math.PI / 2]);
if (tilted) { let t = await dragRight(tilted, 100, 10);
	check('C. a ring ' + (t.edge_on ? 'just inside' : 'just outside') + ' the threshold drags evenly too', t.reversals == 0 && Math.abs(t.total) > 10, t); }

// D. what a hand really does: a ring a few degrees off edge-on, dragged sideways with a wobble that crosses its line
await lookFrom('0, 7, 60');
centre = await gizmo();
let slim = await findRing('Y', centre, [0, Math.PI]);
check('D. a ring 3 degrees off edge-on can be grabbed', !!slim, centre);
let steady = await dragRight(slim, 120, 16, 7);
await ev(`(() => { ROTATE_GIZMO.EDGE_ON_DEG = 0; return true; })()`);
let jumpy = await dragRight(slim, 120, 16, 7);
await ev(`(() => { ROTATE_GIZMO.EDGE_ON_DEG = window.__edge; return true; })()`);
console.log('   wobbling hand, with the fix:', JSON.stringify({total: steady.total, biggest_step: steady.biggest_step, reversals: steady.reversals}));
console.log('   wobbling hand, old behaviour:', JSON.stringify({values: jumpy.values.map(v => Math.round(v)), biggest_step: jumpy.biggest_step, reversals: jumpy.reversals}));
check('   a wobbling hand turns it evenly with the fix: no reversals, no jumps', steady.edge_on && steady.reversals == 0 && steady.biggest_step <= 10, steady);
check('   and the old plane reading from the same gesture is the spasm: it reverses or jumps', jumpy.reversals > 0 || jumpy.biggest_step > steady.biggest_step * 2, {reversals: jumpy.reversals, biggest_step: jumpy.biggest_step});

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
ws.close();
