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

// Reads the color at the center of every cell and checks each cell differs from its right and lower neighbor
const inspect = (tile) => `(() => { let t = Texture.all.at(-1); if (!t) return 'no texture';
	let ctx = t.canvas.getContext('2d'); let cols = t.width / ${tile}, rows = t.height / ${tile};
	let colors = []; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { let d = ctx.getImageData(c * ${tile} + ${tile} / 2, r * ${tile} + ${tile} / 2, 1, 1).data; colors.push([d[0], d[1], d[2], d[3]].join(',')); }
	let same_neighbor = 0; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { let i = r * cols + c; if (c + 1 < cols && colors[i] == colors[i + 1]) same_neighbor++; if (r + 1 < rows && colors[i] == colors[i + cols]) same_neighbor++; }
	let d0 = ctx.getImageData(0, 0, 1, 1).data, d1 = ctx.getImageData(${tile} - 1, ${tile} - 1, 1, 1).data;
	return JSON.stringify({name: t.name, size: [t.width, t.height], uv_size: [t.getUVWidth(), t.getUVHeight()], cells: colors.length, distinct: new Set(colors).size, same_neighbor, opaque: colors.every(c => c.endsWith(',255')), cell0_flat: [...d0].join() == [...d1].join(), saved_in_project: Texture.all.length}); })()`;

console.log('A. condition:', await ev(`(() => { newProject(Formats.free); let generic = Condition(BarItems.create_dew_atlas.condition); newProject(Formats.dew_scene); let dew = Condition(BarItems.create_dew_atlas.condition);
	let toolbar = Panels.textures.toolbars.find(t => t.id == 'texturelist'); let ids = toolbar.children.map(c => c.id);
	return JSON.stringify({generic, dew, right_of_simple: ids.indexOf('create_dew_atlas') == ids.indexOf('create_simple_texture') + 1, name: BarItems.create_dew_atlas.name}); })()`));

console.log('B. dialog defaults:', await ev(`(() => { BarItems.create_dew_atlas.click(); let d = Dialog.open; return JSON.stringify({id: d.id, values: d.getFormResult()}); })()`));
await ev(`(() => { Dialog.open.confirm(); return true; })()`); await sleep(400);
console.log('   confirm defaults:', await ev(inspect(16)), ' expect 128x128, uv 128x128, 64 distinct, 0 same neighbors');

await ev(`(() => { BarItems.create_dew_atlas.click(); let d = Dialog.open; d.setFormValues({name: 'wide', tile_size: 32, columns: 4, rows: 2}); d.confirm(); return true; })()`); await sleep(400);
console.log('C. 4 x 2 tiles at 32 px:', await ev(inspect(32)), ' expect 128x64, 8 distinct');

console.log('D. undo removes it:', await ev(`(() => { let before = Texture.all.length; Undo.undo(); return JSON.stringify({before, after: Texture.all.length}); })()`));

console.log('page errors:', errors.length ? errors : 'none');
ws.close();
