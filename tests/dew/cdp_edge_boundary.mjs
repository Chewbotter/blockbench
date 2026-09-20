// Edge Boundary: real clicks, same triangulation/UVs, undo, rejected seams and rig weights.
import assert from 'node:assert/strict';
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type == 'page' && t.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0, checks = 0;
const pending = new Map(), errors = [];
ws.onmessage = e => {
	const m = JSON.parse(e.data);
	if (m.method == 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
	if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({id: i, method, params})); });
const ev = async expression => {
	const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
	if (r.error) throw Error(r.error.message);
	if (r.result.exceptionDetails) throw Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
	return r.result.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (label, value) => { assert.ok(value, label); checks++; console.log('PASS ' + label); };
// CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
async function click(point, modifiers = 0) {
	const [x, y] = await ev(`(() => { const p = Preview.selected, s = new THREE.Vector3(${point}).project(p.camera), r = p.canvas.getBoundingClientRect(); return [r.left+(s.x+1)*r.width/2, r.top+(1-s.y)*r.height/2]; })()`);
	await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y, modifiers});
	await send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers});
	await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers});
	await sleep(120);
}
try {
	await send('Runtime.enable');
	await ev(`(() => {
		newProject(Formats.free);
		window.__make = (height = 0) => {
			let m = new Mesh({name: 'boundary.plastic', vertices: {}});
			let v = m.addVertices([0,0,0], [32,0,0], [32,0,32], [0,height,32]);
			let uv = Object.fromEntries(v.map(k => [k, [m.vertices[k][0],m.vertices[k][2]]]));
			m.addFaces(new MeshFace(m, {vertices: [v[0],v[2],v[1]], uv, smoothing_group: 4}), new MeshFace(m, {vertices: [v[0],v[3],v[2]], uv, smoothing_group: 4}));
			m.init(); return {m,v};
		};
		window.__triangles = m => Object.values(m.faces).flatMap(f => {
			let v = f.getSortedVertices(); let tris = v.length == 4 ? [[v[0],v[1],v[2]],[v[0],v[2],v[3]]] : [v];
			return tris.map(t => { let i = t.indexOf(t.slice().sort()[0]); return t.slice(i).concat(t.slice(0,i)).join(','); });
		}).sort();
		window.__fixture = __make(); __fixture.m.select(); updateSelection();
		let p = Preview.selected; p.controls.target.set(16,0,16); p.camera.position.set(16,110,17); p.controls.update(); p.render();
		window.__before = JSON.stringify(__triangles(__fixture.m));
		window.__vertices = JSON.stringify(__fixture.m.vertices);
		BarItems.dew_edge_boundary.select();
	})()`);
	check('toolbar contains Edge Boundary next to Turn Edges', await ev(`Toolbars.tools.children.findIndex(x => x.id == 'dew_edge_boundary') == Toolbars.tools.children.findIndex(x => x.id == 'turn_edges_tool') + 1`));
	await sleep(300);
	await click([16,0,16]);
	check('click hides the shared triangle edge as one quad', await ev(`Object.values(__fixture.m.faces).length == 1 && Object.values(__fixture.m.faces)[0].vertices.length == 4`));
	check('render diagonal and vertex keys stay unchanged', await ev(`JSON.stringify(__triangles(__fixture.m)) == __before && JSON.stringify(__fixture.m.vertices) == __vertices`));
	check('quad guide is visible in this tool', await ev(`__fixture.m.mesh.turn_edges.visible && __fixture.m.mesh.turn_edges.vertex_order.length == 2`));
	check('UVs and smoothing group survive the merge', await ev(`Object.values(__fixture.m.faces).every(f => f.smoothing_group == 4 && f.vertices.every(v => f.uv[v][0] == __fixture.m.vertices[v][0] && f.uv[v][1] == __fixture.m.vertices[v][2]))`));
	await click([16,0,16]);
	check('second click restores two triangles with the same diagonal', await ev(`Object.values(__fixture.m.faces).length == 2 && JSON.stringify(__triangles(__fixture.m)) == __before`));
	await ev('Undo.undo()');
	check('undo restores the quad', await ev('Object.values(__fixture.m.faces).length == 1'));
	await ev('Undo.redo()');
	check('redo restores the triangles', await ev('Object.values(__fixture.m.faces).length == 2'));
	const history = await ev('Undo.history.length');
	await click([16,0,0.2]);
	await click([22,0,7]);
	check('outer borders and clicks away from edges do not edit', await ev('Undo.history.length') == history);
	await click([16,0,16]);
	await ev('BarItems.move_tool.select(); true'); await sleep(50);
	check('leaving the tool hides the diagonal guide', await ev('!__fixture.m.mesh.turn_edges.visible'));
	await ev('BarItems.turn_edges_tool.select(); true');
	await click([16,0,16]);
	check('Turn Edges still flips the quad diagonal', await ev('JSON.stringify(__triangles(__fixture.m)) != __before'));
	await ev('Undo.undo(); BarItems.dew_edge_boundary.select(); true');
	check('bbmodel face serialization retains quad and diagonal', await ev(`(() => { let m=__fixture.m, copy=m.getSaveCopy(), restored=new Mesh(copy); return JSON.stringify(__triangles(restored))==__before && Object.values(restored.faces)[0].vertices.length==4; })()`));
	check('folded pair joins without changing its triangles', await ev(`(() => { let {m,v}=__make(12); let before=JSON.stringify(__triangles(m)), r=DEWQuads.toggleEdgeBoundary(m,v[0],v[2]); return !r.error && JSON.stringify(__triangles(m))==before; })()`));
	// Ctrl forces past the three texture rules only. The geometric rules decide whether the
	// quad can exist at all, so they must still reject when forced.
	for (const [label, change, forceable] of [
		['texture boundary', `f[0].texture='texture-a'; f[1].texture='texture-b'`, true],
		['UV seam', `let t=new Texture({name:'seam'}).add(false); f.forEach(x=>x.texture=t.uuid); f[1].uv[v[0]]=[99,99]`, true],
		['different smoothing groups', `f[1].smoothing_group=8`, true],
		['inconsistent winding', `f[1].invert()`, false],
		['nonmanifold edge', `m.addFaces(new MeshFace(m,f[0]))`, false],
	]) {
		check(label + ' is rejected without an undo entry or mesh change', await ev(`(() => { let {m,v}=__make(), f=Object.values(m.faces); ${change}; let before=JSON.stringify(m.getUndoCopy()), n=Undo.history.length; let r=DEWQuads.toggleEdgeBoundary(m,v[0],v[2]); return !!r.error && JSON.stringify(m.getUndoCopy())==before && Undo.history.length==n; })()`));
		check(label + (forceable ? ' joins when forced' : ' is still rejected when forced'), await ev(`(() => { let {m,v}=__make(), f=Object.values(m.faces); ${change}; let r=DEWQuads.toggleEdgeBoundary(m,v[0],v[2],true); let faces=Object.values(m.faces); return ${forceable ? `!r.error && faces.length==1 && faces[0].vertices.length==4` : `!!r.error`}; })()`));
	}
	check('a forced join keeps the first triangle uvs and is undoable', await ev(`(() => {
		let {m,v}=__make(), f=Object.values(m.faces);
		let t=new Texture({name:'seam3'}).add(false); f.forEach(x=>x.texture=t.uuid); f[1].uv[v[0]]=[99,99];
		let before=JSON.stringify(m.getUndoCopy()), kept=JSON.stringify(f[0].uv[v[0]]);
		let r=DEWQuads.toggleEdgeBoundary(m,v[0],v[2],true), quad=Object.values(m.faces)[0];
		let held = JSON.stringify(quad.uv[v[0]])==kept;
		Undo.undo(); return !r.error && held && JSON.stringify(m.getUndoCopy())==before;
	})()`));
	check('rig vertex weights survive join, split and undo', await ev(`(() => {
		let {m,v}=__make(), arm=new Armature({name:'rig'}).init(), bone=new ArmatureBone({name:'joint'}).addTo(arm).init();
		m.addTo(arm); v.forEach((key,i)=>bone.setVertexWeight(m,key,(i+1)/4));
		let before=v.map(k=>bone.getVertexWeight(m,k));
		let a=DEWQuads.toggleEdgeBoundary(m,v[0],v[2]), b=DEWQuads.toggleEdgeBoundary(m,v[0],v[2]);
		Undo.undo(); return !a.error && !b.error && v.every((k,i)=>bone.getVertexWeight(m,k)==before[i]);
	})()`));
	// The wiring from the real event is the part most likely to break: Ctrl must reach
	// onCanvasClick rather than being swallowed by a preview handler.
	await ev(`(() => {
		Mesh.all.slice().forEach(m => m.remove());
		let {m,v} = __make(), f = Object.values(m.faces);
		let t = new Texture({name:'seam.click'}).add(false); f.forEach(x => x.texture = t.uuid); f[1].uv[v[0]] = [99,99];
		window.__fixture = {m,v}; m.select(); updateSelection();
		BarItems.dew_edge_boundary.select(); Preview.selected.render(); return true;
	})()`);
	await sleep(200);
	await click([16,0,16]);
	check('a plain click still refuses the seam in the viewport', await ev(`Object.values(__fixture.m.faces).length == 2`));
	await click([16,0,16], 2);
	check('Ctrl click joins the seam in the viewport', await ev(`(() => { let f=Object.values(__fixture.m.faces); return f.length==1 && f[0].vertices.length==4; })()`));
	await ev('Undo.undo()');
	check('undo restores the two triangles after a forced click', await ev(`Object.values(__fixture.m.faces).length == 2`));
	check('no renderer exceptions', errors.length == 0);
	console.log('RESULT: PASS (' + checks + ' checks)');
} finally { ws.close(); }
