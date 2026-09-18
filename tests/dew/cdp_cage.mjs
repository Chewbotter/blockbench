// Cage bindings, selection boundaries, undo, resolution changes and real pointer interaction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type == 'page' && t.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id=0, checks=0; const pending=new Map(), errors=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method=='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}};
const send=(method,params={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method,params}))});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.error||r.result.exceptionDetails)throw Error(JSON.stringify(r));return r.result.result.value};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label)};
try {
	await send('Runtime.enable');
	await ev(`(() => {
		newProject(Formats.free);
		window.fixture = () => {
			BarItems.move_tool.select();Mesh.all.slice().forEach(m=>m.remove());unselectAllElements();
			window.m=new Mesh({name:'cage.plastic',vertices:{}});window.v=[];
			for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++)v.push(m.addVertices([x*16-8,y*16-8,z*16-8])[0]);
			v.push(...m.addVertices([0,0,0],[7,7,7]));
			for(const indices of [[0,2,3,1],[4,5,7,6],[0,1,5,4],[2,6,7,3],[0,4,6,2],[1,3,7,5]]) {
				const vertices=indices.map(i=>v[i]);m.addFaces(new MeshFace(m,{vertices,texture:false,uv:Object.fromEntries(vertices.map((key,i)=>[key,[[0,0],[16,0],[16,16],[0,16]][i]]))}));
			}
			m.init();m.select();BarItems.selection_mode.set('object');updateSelection();BarItems.dew_cage.select();DEWCage.setResolution([2,2,2]);BarItems.dew_cage_axis.set('view');BarItems.dew_cage_mode.change('move');
			const p=Preview.selected;p.controls.target.set(0,0,0);p.camera.position.set(64,48,80);p.controls.update();p.render();
		};
		window.beginTest = ids => DEWCage.begin(Preview.selected,{clientX:500,clientY:300,pointerId:1},ids);
		window.changeTest = (ids,delta) => {beginTest(ids);DEWCage.moveBy(new THREE.Vector3(...delta));DEWCage.finish(true);};
		window.near = (a,b) => a.length==b.length&&a.every((value,i)=>Math.abs(value-b[i])<1e-6);
		window.corners = () => DEWCage.getState().controls.map(p=>p.toArray());
		fixture();
	})()`);
	check('tool is in the toolbar and defaults to eight cage points',await ev(`Toolbars.tools.children.some(t=>t.id=='dew_cage') && DEWCage.getState().controls.length==8 && Toolbars.dew_cage.children.some(t=>t.id=='dew_cage_mode')`));
	check('identity cage keeps vertices, UVs and topology untouched',await ev(`(()=>{let before=JSON.stringify(m.getSaveCopy());DEWCage.fit();return JSON.stringify(m.getSaveCopy())==before})()`));
	const base=await ev('JSON.stringify(m.getSaveCopy())');
	check('one corner pulls the center by one eighth and leaves the opposite corner fixed',await ev(`(()=>{changeTest([7],[8,0,0]);return near(m.vertices[v[7]],[16,8,8])&&near(m.vertices[v[8]],[1,0,0])&&near(m.vertices[v[0]],[-8,-8,-8]);})()`));
	const changed=await ev('JSON.stringify(m.getSaveCopy())'), bent=await ev('corners()');
	await ev('Undo.undo();true');
	check('undo restores mesh and original cage',await ev('JSON.stringify(m.getSaveCopy())')==base && await ev('near(corners()[7],[8,8,8])'));
	await ev('Undo.redo();true');
	check('redo restores mesh and deformed cage',await ev('JSON.stringify(m.getSaveCopy())')==changed && JSON.stringify(await ev('corners()'))==JSON.stringify(bent));
	check('second handle drag retains the first handle displacement',await ev(`(()=>{changeTest([6],[0,8,0]);return near(corners()[7],[16,8,8])&&near(corners()[6],[-8,16,8])&&near(m.vertices[v[8]],[1,1,0]);})()`));
	check('UVs, face lists and material suffix are preserved',await ev(`(()=>{let original=JSON.parse(${JSON.stringify(base)}),now=m.getSaveCopy();return JSON.stringify(now.faces)==JSON.stringify(original.faces)&&now.name==original.name;})()`));
	check('Escape cancels the current drag without an undo entry',await ev(`(()=>{let before=JSON.stringify(m.vertices),c=JSON.stringify(corners()),n=Undo.history.length;beginTest([0]);DEWCage.moveBy(new THREE.Vector3(-8,0,0));document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return !DEWCage.getDrag()&&JSON.stringify(m.vertices)==before&&JSON.stringify(corners())==c&&Undo.history.length==n&&Preview.selected.controls.enabled;})()`));
	check('click without movement adds no undo entry',await ev(`(()=>{let n=Undo.history.length;beginTest([0]);DEWCage.finish(true);return Undo.history.length==n;})()`));
	check('resolution controls add a middle row while preserving current geometry',await ev(`(()=>{let before=JSON.stringify(m.vertices);BarItems.dew_cage_y.change('3');return DEWCage.getState().controls.length==12&&JSON.stringify(m.vertices)==before&&BarItems.dew_cage_y.value=='3';})()`));
	check('a middle row bends the center while end rows stay fixed',await ev(`(()=>{fixture();DEWCage.setResolution([2,3,2]);let before=JSON.parse(JSON.stringify(m.vertices));changeTest([2,3,8,9],[8,0,0]);return near(m.vertices[v[8]],[8,0,0])&&v.slice(0,8).every(k=>near(m.vertices[k],before[k]));})()`));
	check('resolution bounds remain valid and finite on flat selections',await ev(`(()=>{fixture();BarItems.selection_mode.set('vertex');m.getSelectedVertices(true).replace(v.slice(0,4));updateSelection();DEWCage.setResolution([0,99,3]);let s=DEWCage.getState();changeTest([0],[0,0,4]);return s.binding.counts.join()==[2,5,3].join()&&Object.values(m.vertices).flat().every(Number.isFinite);})()`));
	check('component selection changes only selected vertices',await ev(`(()=>{fixture();BarItems.selection_mode.set('vertex');m.getSelectedVertices(true).replace([v[0],v[7],v[8]]);updateSelection();let before=JSON.parse(JSON.stringify(m.vertices));changeTest([7],[8,0,0]);return near(m.vertices[v[8]],[1,0,0])&&v.filter(k=>![v[0],v[7],v[8]].includes(k)).every(k=>near(before[k],m.vertices[k]));})()`));
	check('formats without component selection bind the whole selected mesh',await ev(`(()=>{let original=BarItems.selection_mode.condition;try{BarItems.selection_mode.condition=()=>false;DEWCage.fit();return DEWCage.getState().binding.items[0].keys.length==Object.keys(m.vertices).length;}finally{BarItems.selection_mode.condition=original;DEWCage.fit();}})()`));
	check('dragging an edge moves its two points and gives proportional falloff',await ev(`(()=>{fixture();changeTest([5,7],[0,0,8]);return near(m.vertices[v[5]],[8,-8,16])&&near(m.vertices[v[7]],[8,8,16])&&near(m.vertices[v[8]],[0,0,2])&&near(m.vertices[v[0]],[-8,-8,-8]);})()`));
	check('dragging a face moves its four points and leaves the opposite face fixed',await ev(`(()=>{fixture();changeTest([4,5,7,6],[0,0,8]);return near(m.vertices[v[8]],[0,0,4])&&v.slice(0,4).every(k=>m.vertices[k][2]==-8)&&v.slice(4,8).every(k=>m.vertices[k][2]==16);})()`));
	check('screen picking identifies cage edges and faces',await ev(`(()=>{fixture();let p=Preview.selected;p.render();let r=p.canvas.getBoundingClientRect();let pickAt=point=>{let q=point.project(p.camera);return DEWCage.pick(p,{clientX:r.left+(q.x+1)*r.width/2,clientY:r.top+(1-q.y)*r.height/2}).ids;};return pickAt(new THREE.Vector3(8,0,8)).join()==[5,7].join()&&pickAt(new THREE.Vector3(0,0,8)).join()==[4,5,7,6].join();})()`));
	check('multi-object cage respects rotated and translated local coordinate systems',await ev(`(()=>{
		fixture();BarItems.move_tool.select();let other=new Mesh(m.getSaveCopy());other.uuid=guid();other.name='other.metal';other.origin=[30,0,0];other.rotation=[0,35,20];other.init();other.markAsSelected();updateSelection();
		BarItems.dew_cage.select();DEWCage.fit();let s=DEWCage.getState();let expected=s.binding.items.map(item=>item.base.map(p=>p.clone().add(new THREE.Vector3(3,5,-2))));
		changeTest(s.controls.map((p,i)=>i),[3,5,-2]);
		return s.binding.items.every((item,j)=>item.keys.every((key,i)=>new THREE.Vector3().fromArray(item.mesh.vertices[key]).applyMatrix4(item.mesh.mesh.matrixWorld).distanceTo(expected[j][i])<1e-6));
	})()`));
	check('switching tools removes the cage and cancels an unfinished drag',await ev(`(()=>{let before=JSON.stringify(m.vertices);beginTest([0]);DEWCage.moveBy(new THREE.Vector3(4,0,0));BarItems.move_tool.select();return DEWCage.getState()==null&&!Canvas.scene.children.some(c=>c.name=='Cage preview')&&JSON.stringify(m.vertices)==before&&Preview.selected.controls.enabled;})()`));
	check('cage edits retain armature vertex weights',await ev(`(()=>{fixture();BarItems.move_tool.select();let arm=new Armature({name:'rig'}).init(),bone=new ArmatureBone({name:'joint'}).addTo(arm).init();m.addTo(arm);v.forEach((key,i)=>bone.setVertexWeight(m,key,(i+1)/v.length));let weights=v.map(k=>bone.getVertexWeight(m,k));m.select();updateSelection();BarItems.dew_cage.select();changeTest([7],[4,0,0]);return v.every((key,i)=>bone.getVertexWeight(m,key)==weights[i]);})()`));

	await ev('fixture();true');await sleep(400);
	const screen=await ev(`(()=>{const p=Preview.selected;p.render();const q=DEWCage.getState().controls[7].clone().project(p.camera),r=p.canvas.getBoundingClientRect();return{x:r.left+(q.x+1)*r.width/2,y:r.top+(1-q.y)*r.height/2};})()`);
	check('screen picking finds the visible cage corner',await ev(`DEWCage.pick(Preview.selected,{clientX:${screen.x},clientY:${screen.y}}).ids.join()=='7'`));
	const beforeMouse=await ev('JSON.stringify(m.vertices)');
	await ev(`BarItems.dew_cage_axis.set('x');true`);
	await send('Input.dispatchMouseEvent',{type:'mouseMoved',...screen});
	await send('Input.dispatchMouseEvent',{type:'mousePressed',...screen,button:'left',buttons:1,clickCount:1});
	check('real pointer press starts a cage drag',await ev('!!DEWCage.getDrag()'));
	for(const delta of [10,20])await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:screen.x+delta,y:screen.y-delta,button:'left',buttons:1});
	check('real mouse drag deforms proportionally and leaves selection intact',await ev(`(()=>{let before=JSON.parse(${JSON.stringify(beforeMouse)}),a=m.vertices[v[7]],b=before[v[7]],center=m.vertices[v[8]];return a.some((n,i)=>Math.abs(n-b[i])>0.01)&&near(center,a.map((n,i)=>(n-b[i])/8))&&m.selected;})()`));
	check('axis-constrained mouse drag changes only that world coordinate',await ev(`(()=>{let before=JSON.parse(${JSON.stringify(beforeMouse)});return v.every(k=>m.vertices[k][1]==before[k][1]&&m.vertices[k][2]==before[k][2]);})()`));
	await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:screen.x+20,y:screen.y-20,button:'left',clickCount:1});
	check('release restores camera control and completes one edit',await ev(`!DEWCage.getDrag()&&Preview.selected.controls.enabled&&Undo.history[Undo.index-1].action=='Deform cage'`));
	await ev('Undo.undo();true');
	check('real mouse edit can be undone',await ev('JSON.stringify(m.vertices)')==beforeMouse);
	check('preview cage is not saved as model geometry',await ev(`(()=>{let saved=JSON.parse(Codecs.project.compile());return saved.elements.filter(e=>e.type=='mesh').length==Mesh.all.length&&saved.elements.every(e=>OutlinerNode.uuids[e.uuid])&&!JSON.stringify(saved).includes('Cage preview');})()`));

	// Box selection uses actual mouse events, including hidden points and additive/subtractive gestures.
	await ev(`fixture();BarItems.dew_cage_mode.change('select');
		window.cageScreen = () => {let p=Preview.selected,r=p.canvas.getBoundingClientRect();p.render();return DEWCage.getState().controls.map(point=>{let q=point.clone().project(p.camera);return{x:r.left+(q.x+1)*r.width/2,y:r.top+(1-q.y)*r.height/2};});};
		window.selectedPoints = () => [...DEWCage.getState().selected].sort((a,b)=>a-b).join();
		Preview.selected.camera.position.set(0,0,80);Preview.selected.controls.update();true`);
	await sleep(400);
	const projected=await ev('cageScreen()');
	const bounds=ids=>({a:{x:Math.min(...ids.map(i=>projected[i].x))-12,y:Math.min(...ids.map(i=>projected[i].y))-12},b:{x:Math.max(...ids.map(i=>projected[i].x))+12,y:Math.max(...ids.map(i=>projected[i].y))+12}});
	const allBox=bounds([0,1,2,3,4,5,6,7]),leftBox=bounds([0,2,4,6]),rightBox=bounds([1,3,5,7]);
	const press=async(p,modifiers=0)=>{await send('Input.dispatchMouseEvent',{type:'mouseMoved',...p,modifiers});await send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',buttons:1,clickCount:1,modifiers});};
	const move=async(p,modifiers=0)=>send('Input.dispatchMouseEvent',{type:'mouseMoved',...p,buttons:1,button:'left',modifiers});
	const release=async(p,modifiers=0)=>send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1,modifiers});
	const box=async({a,b},modifiers=0)=>{await press(a,modifiers);await move(b,modifiers);await release(b,modifiers);};
	const beforeSelect=await ev('JSON.stringify(m.getSaveCopy())'),undoBeforeSelect=await ev('Undo.index');
	await box(allBox);
	check('box selects all eight points including those behind the mesh',await ev(`selectedPoints()=='0,1,2,3,4,5,6,7'`));
	await box(rightBox,1);
	check('Alt box subtracts points from the selection',await ev(`selectedPoints()=='0,2,4,6'`));
	await box(rightBox,8);
	check('Shift box adds points to the selection',await ev(`selectedPoints()=='0,1,2,3,4,5,6,7'`));
	await box(rightBox);
	check('plain box replaces the selection and leaves model geometry and undo untouched',await ev(`selectedPoints()=='1,3,5,7' && JSON.stringify(m.getSaveCopy())==${JSON.stringify(beforeSelect)} && Undo.index==${undoBeforeSelect} && !DEWCage.getMarquee() && !document.querySelector('.dew_cage_marquee') && Preview.selected.controls.enabled`));
	await press(allBox.a);await move(allBox.b);
	await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);await release(allBox.b);
	check('Escape cancels box selection and restores the prior points and camera controls',await ev(`selectedPoints()=='1,3,5,7' && !DEWCage.getMarquee() && !document.querySelector('.dew_cage_marquee') && Preview.selected.controls.enabled`));
	await press(leftBox.a);await move(leftBox.b);
	await ev('BarItems.move_tool.select();true');await release(leftBox.b);
	check('switching tools cleans up an unfinished selection rectangle',await ev(`!DEWCage.getState() && !DEWCage.getMarquee() && !document.querySelector('.dew_cage_marquee') && Preview.selected.controls.enabled`));
	await ev(`fixture();BarItems.dew_cage_mode.change('select');true`);await sleep(200);
	const cornerClick=(await ev('cageScreen()'))[7];
	await press(cornerClick);await release(cornerClick);
	check('Select mode click selects one point without deforming it',await ev(`selectedPoints()=='7' && near(corners()[7],[8,8,8])`));
	await ev(`BarItems.dew_cage_mode.change('scale');true`);
	await press(cornerClick);await release(cornerClick);
	check('scaling requires at least two selected points',await ev(`!DEWCage.getDrag() && near(corners()[7],[8,8,8]) && Preview.selected.controls.enabled`));
	check('axis scaling widens the top row symmetrically while the bottom row stays fixed',await ev(`(()=>{fixture();DEWCage.selectPoints([2,3,6,7]);BarItems.dew_cage_mode.change('scale');BarItems.dew_cage_axis.set('x');beginTest([2,3,6,7]);DEWCage.scaleBy(2);DEWCage.finish();return near(corners()[2],[-16,8,-8])&&near(corners()[3],[16,8,-8])&&near(corners()[6],[-16,8,8])&&near(corners()[7],[16,8,8])&&[0,1,4,5].every(i=>Math.abs(corners()[i][0])==8)&&near(m.vertices[v[8]],[0,0,0])&&near(m.vertices[v[9]],[13.5625,7,7]);})()`));
	check('scale undo and redo restore both cage geometry and the point selection',await ev(`(()=>{let scaled=JSON.stringify(m.vertices),handles=JSON.stringify(corners());Undo.undo();let undone=near(corners()[2],[-8,8,-8])&&selectedPoints()=='2,3,6,7';Undo.redo();return undone&&JSON.stringify(m.vertices)==scaled&&JSON.stringify(corners())==handles&&selectedPoints()=='2,3,6,7'&&Undo.history[Undo.index-1].action=='Scale cage';})()`));
	check('scaling uses the selected bounding center even with unevenly spaced points',await ev(`(()=>{fixture();DEWCage.setResolution([3,2,2]);changeTest([1],[2,0,0]);BarItems.dew_cage_mode.change('scale');beginTest([0,1,2]);DEWCage.scaleBy(2);DEWCage.finish();return near(corners()[0],[-16,-8,-8])&&near(corners()[1],[4,-8,-8])&&near(corners()[2],[16,-8,-8])&&near(corners()[3],[-8,8,-8]);})()`));
	check('scaling a flat selected row along its zero-extent axis creates no edit or invalid vertices',await ev(`(()=>{fixture();BarItems.dew_cage_mode.change('scale');BarItems.dew_cage_axis.set('y');let n=Undo.index,before=JSON.stringify(m.vertices);beginTest([2,3,6,7]);DEWCage.scaleBy(2);DEWCage.finish();return Undo.index==n&&JSON.stringify(m.vertices)==before&&Object.values(m.vertices).flat().every(Number.isFinite);})()`));
	check('Escape rolls back a group scale without changing the selection',await ev(`(()=>{fixture();BarItems.dew_cage_mode.change('scale');let before=JSON.stringify(m.vertices),n=Undo.index;beginTest([2,3,6,7]);DEWCage.scaleBy(1.8);document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return JSON.stringify(m.vertices)==before&&Undo.index==n&&selectedPoints()=='2,3,6,7'&&!DEWCage.getDrag();})()`));
	// Real group move and scale preserve the selected group when a single member is grabbed.
	await ev(`fixture();DEWCage.selectPoints([2,3,6,7]);BarItems.dew_cage_axis.set('x');true`);await sleep(200);
	const groupCorner=(await ev('cageScreen()'))[7];
	await press(groupCorner);await move({x:groupCorner.x+25,y:groupCorner.y});await release({x:groupCorner.x+25,y:groupCorner.y});
	check('dragging one selected point moves the entire selected group',await ev(`(()=>{let s=DEWCage.getState(),d=s.controls[7].clone().sub(s.binding.rest[7]);return selectedPoints()=='2,3,6,7'&&d.length()>0.01&&[2,3,6,7].every(i=>s.controls[i].clone().sub(s.binding.rest[i]).distanceTo(d)<1e-6)&&[0,1,4,5].every(i=>s.controls[i].equals(s.binding.rest[i]));})()`));
	await ev(`fixture();DEWCage.selectPoints([0,1,2,3,4,5,6,7]);BarItems.dew_cage_mode.change('scale');true`);await sleep(200);
	const scaleStart=(await ev('cageScreen()'))[7];
	const pivot=await ev(`(()=>{let p=Preview.selected,r=p.canvas.getBoundingClientRect(),q=new THREE.Vector3().project(p.camera);return{x:r.left+(q.x+1)*r.width/2,y:r.top+(1-q.y)*r.height/2};})()`);
	const scaleEnd={x:pivot.x+(scaleStart.x-pivot.x)*1.5,y:pivot.y+(scaleStart.y-pivot.y)*1.5};
	await press(scaleStart);await move(scaleEnd);await release(scaleEnd);
	check('real Scale drag expands selected points uniformly about their center',await ev(`(()=>{let s=DEWCage.getState(),factor=s.controls[7].x/8;return selectedPoints()=='0,1,2,3,4,5,6,7'&&Math.abs(factor-1.5)<0.03&&s.controls.every((p,i)=>p.distanceTo(s.binding.rest[i].clone().multiplyScalar(factor))<1e-6)&&near(m.vertices[v[8]],[0,0,0]);})()`));
	check('changing resolution clears old point IDs and preserves the scaled geometry',await ev(`(()=>{let before=JSON.stringify(m.vertices);DEWCage.setResolution([2,3,2]);return DEWCage.getState().selected.size==0&&JSON.stringify(m.vertices)==before;})()`));
	await ev(`DEWCage.selectPoints([2,3,8,9]);true`);
	// Inspect the actual tool presentation without opening a window for the user.
	await send('Page.enable');
	const capture=await send('Page.captureScreenshot',{format:'png'});
	if(process.env.CAGE_SCREENSHOT)fs.writeFileSync(process.env.CAGE_SCREENSHOT,Buffer.from(capture.result.data,'base64'));
	if(process.env.EDGE_DRAG_MODEL) {
		const model=JSON.parse(fs.readFileSync(process.env.EDGE_DRAG_MODEL,'utf8'));
		await ev(`Codecs.project.load(${JSON.stringify(model)},{path:${JSON.stringify(process.env.EDGE_DRAG_MODEL)}});true`);
		console.log('sedan cage timings',await ev(`(()=>{unselectAllElements();window.m=Mesh.all.slice().sort((a,b)=>Object.keys(b.faces).length-Object.keys(a.faces).length)[0];m.select();BarItems.selection_mode.set('object');updateSelection();BarItems.dew_cage.select();BarItems.dew_cage_mode.change('move');DEWCage.fit();beginTest([7]);let times=[];for(let i=1;i<=12;i++){let t=performance.now();DEWCage.moveBy(new THREE.Vector3(i*.2,0,0));times.push(performance.now()-t);}DEWCage.finish(true);return{mesh:m.name,faces:Object.keys(m.faces).length,ms:times};})()`));
		check('cage safely refits after switching projects',await ev('DEWCage.getState().binding.project==Project.uuid && DEWCage.getState().binding.items[0].mesh==m'));
	}
	check('no renderer exceptions',errors.length==0);
	console.log('RESULT: PASS ('+checks+' checks)');
} finally {ws.close()}
