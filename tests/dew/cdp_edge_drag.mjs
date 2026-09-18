// Regression coverage for edge counting and geometry-dependent quad ordering during a drag.
// Run in an isolated app. Optionally set EDGE_DRAG_MODEL to profile a real bbmodel without saving it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
	if (r.error || r.result.exceptionDetails) throw Error(JSON.stringify(r));
	return r.result.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (label, result) => { assert.ok(result, label); console.log('PASS ' + label); checks++; };
async function pointer() {
	await sleep(300);
	const point = await ev(`(() => {
		const p = Preview.selected; p.occupyTransformer(); Transformer.update(); p.render();
		const handle = Transformer.children[0].handles.children.find(c => c.name == 'Y' && c.type == 'Mesh');
		const v = new THREE.Box3().setFromObject(handle).getCenter(new THREE.Vector3()).project(p.camera);
		const r = p.canvas.getBoundingClientRect(); return {x:r.left+(v.x+1)*r.width/2, y:r.top+(1-v.y)*r.height/2};
	})()`);
	for (let i = 0; i < 2; i++) await send('Input.dispatchMouseEvent', {type:'mouseMoved', ...point});
	assert.equal(await ev('Transformer.hoverAxis'), 'Y', 'mouse must hit the Y gizmo');
	return point;
}
try {
	await send('Runtime.enable');
	await ev(`(() => {
		newProject(Formats.free); settings.auto_fix_mesh_edits.value = false;
		window.makeDragFixture = (mode = 'edge') => {
			Mesh.all.slice().forEach(m => m.remove()); unselectAllElements();
			window.m = new Mesh({name:'drag.metal', vertices:{}});
			window.v = m.addVertices([-16,0,0], [16,0,0], [16,0,32], [-16,0,32]);
			window.fkey = m.addFaces(new MeshFace(m, {vertices:v, texture:false, uv:Object.fromEntries(v.map((k,i) => [k, [[0,0],[16,0],[16,16],[0,16]][i]]))}))[0];
			m.init(); m.select(); BarItems.move_tool.select(); BarItems.transform_space.set('global'); BarItems.selection_mode.set(mode);
			m.getSelectedVertices(true).replace(mode == 'face' ? v : v.slice(0,2));
			m.getSelectedEdges(true).replace(mode == 'edge' ? [v.slice(0,2)] : []);
			m.getSelectedFaces(true).replace(mode == 'face' ? [fkey] : []); updateSelection();
			const p = Preview.selected; p.controls.target.set(0,0,10); p.camera.position.set(80,80,100); p.controls.update(); p.render();
		};
		window.snapDrag = () => {
			const g = m.mesh;
			return {pos:Array.from(g.geometry.attributes.position.array), normal:Array.from(g.geometry.attributes.normal.array),
				index:Array.from(g.geometry.index.array), uv:Array.from(g.geometry.attributes.uv.array),
				outline:Array.from(g.outline.geometry.attributes.position.array), outline_order:g.outline.vertex_order.slice(),
				turn:Array.from(g.turn_edges.geometry.attributes.position.array), turn_order:g.turn_edges.vertex_order.slice()};
		};
		window.compareDrag = (a, b) => Object.keys(a).every(k => a[k].length == b[k].length && a[k].every((x,i) =>
			typeof x == 'number' ? Number.isFinite(x) && Math.abs(x-b[k][i]) < 1e-5 : x == b[k][i]));
		window.matchesStock = () => {
			const during = snapDrag(); m.preview_controller.updateGeometry(m, {}); const stock = snapDrag();
			m.preview_controller.updateGeometry(m); return compareDrag(during, stock);
		};
		window.startDrag = () => {
			Transformer.axis = 'Y'; window.dragEvent = {shiftKey:true, altKey:false, ctrlKey:false};
			TransformerModule.active.dispatchPointerDown({event:dragEvent}); moveDrag(0);
		};
		window.moveDrag = y => TransformerModule.active.dispatchMove({event:dragEvent, point:new THREE.Vector3(0,y,0), axis:'y', axis_number:1, direction:1});
		window.endDrag = () => TransformerModule.active.dispatchEnd({event:dragEvent, keep_changes:true});
		makeDragFixture();
	})()`);
	const before = await ev('JSON.stringify(m.getSaveCopy())');
	const point = await pointer();
	await send('Input.dispatchMouseEvent', {type:'mousePressed', ...point, button:'left', buttons:1, clickCount:1, modifiers:8});
	for (const dy of [3,12,24]) await send('Input.dispatchMouseEvent', {type:'mouseMoved', x:point.x, y:point.y-dy, button:'left', buttons:1, modifiers:8});
	check('real Shift drag creates one side quad before release', await ev('Transformer.dragging && Object.keys(m.faces).length == 2 && m.getSelectedVertices().every(k => m.vertices[k][1] > 0)'));
	check('live extrusion indices, normals, UVs, outline and diagonal match a full rebuild', await ev('matchesStock()'));
	const during = await ev('snapDrag()');
	await send('Input.dispatchMouseEvent', {type:'mouseReleased', x:point.x, y:point.y-24, button:'left', clickCount:1, modifiers:8});
	check('release does not change the extruded surface', await ev(`compareDrag(${JSON.stringify(during)}, snapDrag())`));
	const after = await ev('JSON.stringify(m.getSaveCopy())');
	await ev('Undo.undo(); true');
	check('one undo restores geometry and UVs before Shift drag', await ev('JSON.stringify(m.getSaveCopy())') == before);
	await ev('Undo.redo(); true');
	check('redo restores the extrusion and matching render buffers', await ev('JSON.stringify(m.getSaveCopy())') == after && await ev('matchesStock()'));

	for (const mode of ['edge','face']) {
		await ev(`makeDragFixture('${mode}'); startDrag(); moveDrag(4); true`);
		check(mode + ' extrusion renders correctly on the first nonzero move', await ev('matchesStock()'));
		check(mode + ' subsequent drag reuses the fast path', await ev(`(() => {let full=DEWPerf.perf_stats.full, fast=DEWPerf.perf_stats.fast; moveDrag(8); return DEWPerf.perf_stats.full == full && DEWPerf.perf_stats.fast > fast;})()`));
		for (const y of [0,-4,8]) {
			await ev(`moveDrag(${y}); true`);
			check(mode + ' drag through zero to ' + y + ' keeps current triangulation', await ev('matchesStock()'));
		}
		await ev('endDrag(); true');
	}
	check('ordinary vertex deformation updates a changed quad sort before release', await ev(`(() => {
		makeDragFixture(); let original=m.faces[fkey].getSortedVertices().join(); let full=DEWPerf.perf_stats.full;
		m.vertices[v[3]]=[0,0,-16]; m.preview_controller.updateGeometry(m);
		return m.faces[fkey].getSortedVertices().join()!=original && DEWPerf.perf_stats.full>full && matchesStock();
	})()`));
	check('unmoved quads are not re-sorted during fast updates', await ev(`(() => {
		let face=m.faces[fkey], original=face.getSortedVertices, calls=0; face.getSortedVertices=function(){calls++;return original.call(this)};
		try {m.preview_controller.updateGeometry(m);return calls==0;} finally {face.getSortedVertices=original;}
	})()`));
	check('edge counter deduplicates reversed shared edges and loose lines', await ev(`(() => {
		makeDragFixture(); let extra=m.addVertices([32,0,0], [32,0,32], [40,0,0], [48,0,0]);
		m.addFaces(new MeshFace(m,{vertices:[v[1],extra[0],extra[1],v[2]]}), new MeshFace(m,{vertices:extra.slice(2)}));
		m.preview_controller.updateGeometry(m); Interface.status_bar.vue.updateSelectionInfo();
		return Interface.status_bar.vue.selection_info==tl('status_bar.selection.edges','1 / 8');
	})()`));
	if (process.env.EDGE_DRAG_MODEL) {
		const model = JSON.parse(fs.readFileSync(process.env.EDGE_DRAG_MODEL, 'utf8'));
		await ev(`Codecs.project.load(${JSON.stringify(model)}, {path:${JSON.stringify(process.env.EDGE_DRAG_MODEL)}}); true`);
		await sleep(400);
		console.log('model', await ev(`(() => {
			window.m=Mesh.all.slice().sort((a,b)=>Object.keys(b.faces).length-Object.keys(a.faces).length)[0]; unselectAllElements();m.select();BarItems.move_tool.select();
			window.fkey=Object.keys(m.faces)[Math.floor(Object.keys(m.faces).length/2)];window.v=m.faces[fkey].getSortedVertices().slice();
			let box=new THREE.Box3().setFromObject(m.mesh),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()).length();
			let p=Preview.selected;p.controls.target.copy(center);p.camera.position.copy(center).add(new THREE.Vector3(size*.6,size*.5,size*.8));p.controls.update();p.render();
			window.moveTimes=[];window.counterTimes=[];let mod=TransformerModule.active,orig=mod.onMove,counter=Interface.status_bar.vue.updateSelectionInfo;
			mod.onMove=function(...args){let t=performance.now();try{return orig.apply(this,args)}finally{moveTimes.push(performance.now()-t)}};
			Interface.status_bar.vue.updateSelectionInfo=function(...args){let t=performance.now();try{return counter.apply(this,args)}finally{counterTimes.push(performance.now()-t)}};
			return {mesh:m.name,faces:Object.keys(m.faces).length};
		})()`));
		for (const mode of ['face','vertex','edge']) {
			await ev(`BarItems.selection_mode.set('${mode}');m.getSelectedVertices(true).replace('${mode}'=='face'?v:v.slice(0,'${mode}'=='vertex'?1:2));m.getSelectedEdges(true).replace('${mode}'=='edge'?[v.slice(0,2)]:[]);m.getSelectedFaces(true).replace('${mode}'=='face'?[fkey]:[]);updateSelection();true`);
			const p = await pointer();
			await send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',buttons:1,clickCount:1});
			await ev('moveTimes=[];counterTimes=[];true');
			for(const dy of [3,9,15,21,27,36]) await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y-dy,button:'left',buttons:1});
			const timing=await ev(`({changed:TransformerModule.active.has_changed,moveTimes,counterTimes})`);
			check(mode+' mouse drag changes the sedan selection',timing.changed && timing.moveTimes.length>0);
			console.log(mode+' mouse drag ms',JSON.stringify(timing));
			await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y-36,button:'left',clickCount:1});
		}
	}
	check('no renderer exceptions', errors.length == 0);
	console.log('RESULT: PASS ('+checks+' checks)');
} finally { ws.close(); }
