// The fabric snap (handoff section 7, item 2): DEW scenes step by 4, a cube cannot be resized under 4 (8 once
// rotated), Prop Snap drops to whole units, other formats keep the user's own step, and the grid has 4 unit lines.
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

await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove()); unselectAllElements(); updateSelection(); return true; })()`);
await sleep(400);
console.log('A. snap in a DEW scene:', await ev(`JSON.stringify({step: canvasGridSize(), edit_size: Format.edit_size(), user_setting: settings.edit_size.value, limiter: !!Format.cube_size_limiter, toggle: BarItems.dew_prop_snap.value})`));
console.log('   expect step 4, edit_size 4, the user setting untouched, limiter true, toggle false');

await ev(`(() => { BarItems.dew_prop_snap.trigger(); return true; })()`);
console.log('B. prop snap on:', await ev(`JSON.stringify({step: canvasGridSize(), toggle: BarItems.dew_prop_snap.value, shift_step: canvasGridSize(true, false)})`), ' expect step 1, toggle true, shift step still the user\'s');
await ev(`(() => { BarItems.dew_prop_snap.trigger(); return true; })()`);
console.log('   off again:', await ev(`canvasGridSize()`), ' expect 4');

// Resizing under the minimum: Cube.resize is what the gizmo and the size sliders drive
await ev(`(() => { let c = new Cube({name: 'box', from: [0, 0, 0], to: [16, 16, 16]}).init(); c.select(); return true; })()`);
console.log('C. shrink x by 14 from the to side:', await ev(`(() => { let c = Cube.all[0]; c.resize(-14, 0, false); return JSON.stringify({from: c.from, to: c.to}); })()`), ' expect to x 4: clamped to the minimum, from untouched');
console.log('   the from side pushed under the minimum:', await ev(`(() => { let c = Cube.all[0]; c.from[1] = 15; DEWMaterial.fabric_limiter.clamp(c, {}, 1, true); return JSON.stringify({from: c.from, to: c.to}); })()`), ' expect from y 12, to y 16: the dragged side is pushed back to 4 thick, the other stays');
console.log('   grow z by 8:', await ev(`(() => { let c = Cube.all[0]; c.resize(8, 2, false); return JSON.stringify({to: c.to}); })()`), ' expect to z 24: no clamping above the minimum');
await ev(`(() => { let c = Cube.all[0]; c.rotation[0] = 30; c.resize(-10, 2, false); return true; })()`);
console.log('D. rotated, shrink z to 14:', await ev(`(() => { let c = Cube.all[0]; return JSON.stringify({rotation: c.rotation, size_z: c.to[2] - c.from[2], test: DEWMaterial.fabric_limiter.test(c)}); })()`), ' expect size_z 14 (above 8, allowed); test true only because x is 4 on a rotated cube');
await ev(`(() => { let c = Cube.all[0]; c.resize(-9, 2, false); return true; })()`);
console.log('   shrink z further to 5:', await ev(`(() => { let c = Cube.all[0]; return JSON.stringify({size_z: c.to[2] - c.from[2]}); })()`), ' expect 8: a rotated cube keeps two samples');
console.log('   size x 4 on the rotated cube is flagged by the save gate:', await ev(`JSON.stringify(DEWMaterial.validateFabric().map(p => p.reasons))`), ' expect one entry naming the rotated minimum');

// Other formats keep their own step
console.log('E. generic model:', await ev(`(() => { newProject(Formats.free); return JSON.stringify({step: canvasGridSize(), limiter: !!Format.cube_size_limiter, toggle_offered: Condition(BarItems.dew_prop_snap.condition)}); })()`), ' expect the user\'s step (16 / their edit_size), no limiter, toggle not offered');

console.log('page errors:', errors.length ? errors : 'none');
ws.close();
