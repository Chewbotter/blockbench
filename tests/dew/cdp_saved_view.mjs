// The view a scene was left in is saved with it and comes back when the file is opened.
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

const view = `(() => { let p = Preview.selected; let r = v => Math.round(v * 100) / 100;
	return JSON.stringify({from: p.camera.position.toArray().map(r), at: p.controls.target.toArray().map(r)}); })()`;
console.log('setting saved per tab:', await ev(`settings.save_view_per_tab.value`), ' expect true: it gates putting a saved view back');

await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove());
	let p = Preview.selected; p.controls.target.set(100, 20, 50); p.camera.position.set(200, 150, 300); p.controls.update(); if (p.render) p.render();
	return true; })()`);
await sleep(300);
console.log('A. the scene is left looking at:', await ev(view), ' expect from 200,150,300 at 100,20,50');
console.log('B. what a save carries:', await ev(`(() => { let model = JSON.parse(Codecs.project.compile());
	let r = v => Math.round(v * 100) / 100;
	let previews = model.view && model.view.previews;
	if (!previews) return JSON.stringify({view: null});
	let mine = previews[Preview.selected.id];
	window.__saved = Codecs.project.compile();
	return JSON.stringify({previews: Object.keys(previews).length, from: mine.position.map(r), at: mine.target.map(r)}); })()`));
console.log('   expect the same numbers, under model.view.previews');

await ev(`(() => { newProject(Formats.dew_scene); Mesh.all.slice().forEach(m => m.remove()); return true; })()`);
await sleep(400);
console.log('C. a fresh DEW scene looks at:', await ev(view), ' expect the cluster framing, nothing like the saved view');
await ev(`(() => { Codecs.project.parse(JSON.parse(window.__saved)); return true; })()`);
await sleep(400);
console.log('D. the saved scene opened again:', await ev(view), ' expect from 200,150,300 at 100,20,50');

// Any format, not only DEW scenes
await ev(`(() => { newProject(Formats.free);
	let p = Preview.selected; p.controls.target.set(10, 20, 30); p.camera.position.set(40, 50, 60); p.controls.update(); if (p.render) p.render();
	window.__plain = Codecs.project.compile();
	newProject(Formats.free);
	let q = Preview.selected; q.controls.target.set(0, 0, 0); q.camera.position.set(-80, 80, -80); q.controls.update(); if (q.render) q.render();
	return true; })()`);
await sleep(400);
console.log('E. a generic model, moved elsewhere:', await ev(view), ' expect from -80,80,-80');
await ev(`(() => { Codecs.project.parse(JSON.parse(window.__plain)); return true; })()`);
await sleep(400);
console.log('F. the generic model opened again:', await ev(view), ' expect from 40,50,60 at 10,20,30');
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
