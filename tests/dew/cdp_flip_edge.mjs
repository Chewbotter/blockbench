// Turn Edges on visible edges: a click on the edge shared by two triangles flips it across the other diagonal,
// an edge of a quad is left alone, and the stock hidden-diagonal turn still works.
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
const screen = async (x, y, z) => JSON.parse(await ev(`(() => { let p = Preview.selected; let v = new THREE.Vector3(${x}, ${y}, ${z}).project(p.camera); let r = p.canvas.getBoundingClientRect(); return JSON.stringify([r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]); })()`));
const mouse = (type, [x, y], extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
async function click(world) { const at = await screen(...world); for (let i = 0; i < 2; i++) { await mouse('mouseMoved', at, { button: 'none' }); await sleep(80); } await mouse('mousePressed', at, { buttons: 1 }); await sleep(70); await mouse('mouseReleased', at, {}); await sleep(300); }

// Two triangles split along (0,0,0)-(32,0,32), plus a quad beside them at x 64..96
await ev(`(() => { newProject(Formats.free); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove());
	let m = new Mesh({name: 'flip', vertices: {}}); let map = {};
	let vert = p => { let k = p.join(','); return map[k] || (map[k] = m.addVertices(p)[0]); };
	let face = pts => { let vs = pts.map(vert); let uv = {}; vs.forEach(v => uv[v] = [m.vertices[v][0], m.vertices[v][2]]); let f = new MeshFace(m, {vertices: vs, uv, texture: false}); m.addFaces(f); if (f.getNormal(true)[1] < 0) f.invert(); };
	face([[0,0,0],[32,0,0],[32,0,32]]); face([[0,0,0],[32,0,32],[0,0,32]]);
	face([[64,0,0],[96,0,0],[96,0,32],[64,0,32]]);
	m.init(); m.select(); updateSelection();
	let p = Preview.selected; p.controls.target.set(48, 0, 16); p.camera.position.set(48, 160, 17); p.controls.update(); if (p.render) p.render();
	BarItems.turn_edges_tool.select(); return true; })()`);
await sleep(400);
const edges = `(() => { let m = Mesh.all[0]; let out = []; for (let f of Object.values(m.faces)) { let vs = f.getSortedVertices(); for (let i = 0; i < vs.length; i++) { let k = [vs[i], vs[(i + 1) % vs.length]].map(v => m.vertices[v].join(',')).sort().join(' - '); out.push(k); } }
	let shared = out.filter((k, i) => out.indexOf(k) != i); let tris = Object.values(m.faces).filter(f => f.vertices.length == 3); let up = tris.every(f => f.getNormal(true)[1] > 0.99);
	let uv_ok = Object.values(m.faces).every(f => f.vertices.every(v => f.uv[v] && f.uv[v][0] == m.vertices[v][0] && f.uv[v][1] == m.vertices[v][2]));
	return JSON.stringify({faces: Object.keys(m.faces).length, shared_edges: shared, tris_face_up: up, uvs_follow_vertices: uv_ok}); })()`;
console.log('start:', await ev(edges), ' expect 3 faces, the shared edge 0,0,0 - 32,0,32');
await click([16, 0, 16]);
console.log('A. click the shared diagonal:', await ev(edges), ' expect 3 faces, shared edge now 0,0,32 - 32,0,0, triangles still face up, uvs still follow vertices');
console.log('   undo action:', await ev(`Undo.history.at(-1)?.action`), ' expect Flip edge');
await ev(`Undo.undo(); true`);
console.log('   undo:', await ev(edges), ' expect the original diagonal back');
const history = await ev(`Undo.history.length`);
await click([80, 0, 1]);
console.log('B. click a quad edge:', await ev(edges), ' undo steps added:', (await ev(`Undo.history.length`)) - history, ' expect unchanged, 0 steps');
await ev(`(() => { let m = Mesh.all[0]; let quad = Object.values(m.faces).find(f => f.vertices.length == 4); window.__crease = quad.getSortedVertices().slice(); return true; })()`);
await click([80, 0, 16]);
console.log('C. click the quad middle (hidden diagonal):', await ev(`(() => { let m = Mesh.all[0]; let quad = Object.values(m.faces).find(f => f.vertices.length == 4); return JSON.stringify({turned: quad.getSortedVertices()[0] != __crease[0], action: Undo.history.at(-1)?.action, faces: Object.keys(m.faces).length}); })()`), ' expect the stock turn: action Turn edge, still 3 faces');
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
