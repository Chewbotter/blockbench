// Smooth taper on a genuinely subdivided cylinder, mixed edits, history and actual gizmo input.
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
		window.cylinder = () => {
			BarItems.move_tool.select();Mesh.all.slice().forEach(m=>m.remove());unselectAllElements();
			window.m=new Mesh({name:'cylinder.plastic',vertices:{}});window.rings=[];window.samples=[];
			for(let row=0;row<=16;row++){
				let ring=[];for(let side=0;side<32;side++){
					let angle=side*Math.PI/16,point=[8*Math.cos(angle),row*4-32,8*Math.sin(angle)];
					let key=m.addVertices(point)[0];ring.push(key);samples.push({key,point,t:row/16});
				}rings.push(ring);
			}
			for(let row=0;row<16;row++)for(let side=0;side<32;side++){
				let next=(side+1)%32,vertices=[rings[row][side],rings[row+1][side],rings[row+1][next],rings[row][next]];
				m.addFaces(new MeshFace(m,{vertices,texture:false,uv:Object.fromEntries(vertices.map((key,i)=>[key,[[0,0],[0,1],[1,1],[1,0]][i]]))}));
			}
			m.init();m.select();BarItems.selection_mode.set('object');updateSelection();BarItems.dew_cage.select();DEWCage.setResolution([2,2,2]);BarItems.dew_cage_mode.change('scale');DEWCage.selectPoints([2,3,6,7]);
			const p=Preview.selected;p.controls.target.set(0,0,0);p.camera.position.set(90,42,120);p.controls.update();p.render();
		};
		window.closePoint=(a,b)=>a.every((value,i)=>Math.abs(value-b[i])<1e-6);
		window.ease=t=>t*t*(3-2*t);
		window.scaleCage=(factor=2,axis='view',ids=[2,3,6,7])=>{DEWCage.begin(Preview.selected,{clientX:500,clientY:300,pointerId:1},ids,axis);DEWCage.scaleBy(factor);DEWCage.finish();};
		window.matchesRadius=fn=>samples.every(({key,point,t})=>closePoint(m.vertices[key],[point[0]*fn(t),point[1],point[2]*fn(t)]));
		window.cageCorners=()=>DEWCage.getState().controls.map(p=>p.toArray());
		window.projectPoint=point=>{let p=Preview.selected;p.render();let r=p.canvas.getBoundingClientRect(),q=point.clone().project(p.camera);return{x:r.left+(q.x+1)*r.width/2,y:r.top+(1-q.y)*r.height/2};};
		cylinder();
	})()`);
	check('Smooth Scale is the fourth base mode with no separate toggle',await ev(`Object.keys(BarItems.dew_cage_mode.options).join()=='move,select,scale,smooth_scale'&&!BarItems.dew_cage_smooth&&!Toolbars.dew_cage.children.some(t=>t.id=='dew_cage_smooth')`));
	check('ordinary two-row cage scale still produces a straight circular taper',await ev(`(()=>{scaleCage();return matchesRadius(t=>1+t);})()`));
	check('Smooth Scale produces the curved taper and keeps every ring round',await ev(`(()=>{cylinder();BarItems.dew_cage_mode.change('smooth_scale');scaleCage();return matchesRadius(t=>1+ease(t))&&Math.abs(m.vertices[rings[4][0]][0]-9.25)<1e-6&&Math.abs(m.vertices[rings[12][0]][0]-14.75)<1e-6;})()`));
	check('smooth taper leaves the bottom fixed and reaches the exact scaled top',await ev(`rings[0].every(key=>closePoint(m.vertices[key],samples.find(s=>s.key==key).point))&&rings[16].every(key=>{let p=m.vertices[key];return Math.abs(Math.hypot(p[0],p[2])-16)<1e-6&&p[1]==32;})`));
	const curved=await ev('JSON.stringify(m.vertices)'),curvedCorners=await ev('JSON.stringify(cageCorners())');
	check('smooth scale is a single undoable edit with the cage selection intact',await ev(`(()=>{let label=Undo.history[Undo.index-1].action;Undo.undo();let original=matchesRadius(()=>1);Undo.redo();return label=='Smooth scale cage'&&original&&JSON.stringify(m.vertices)==${JSON.stringify(curved)}&&JSON.stringify(cageCorners())==${JSON.stringify(curvedCorners)}&&[...DEWCage.getState().selected].join()=='2,3,6,7';})()`));
	check('switching scale modes does not change the mesh, cage or history',await ev(`(()=>{let n=Undo.index;BarItems.dew_cage_mode.change('scale');BarItems.dew_cage_mode.change('smooth_scale');return JSON.stringify(m.vertices)==${JSON.stringify(curved)}&&JSON.stringify(cageCorners())==${JSON.stringify(curvedCorners)}&&Undo.index==n;})()`));
	check('a normal scale after a smooth scale preserves the existing curve',await ev(`(()=>{BarItems.dew_cage_mode.change('scale');scaleCage(1.5);return matchesRadius(t=>1+ease(t)+t);})()`));
	check('undo and a second smooth scale preserve the first curved deformation',await ev(`(()=>{Undo.undo();BarItems.dew_cage_mode.change('smooth_scale');scaleCage(1.5);return matchesRadius(t=>1+2*ease(t));})()`));
	check('returning a smooth drag to its starting scale creates no edit',await ev(`(()=>{let before=JSON.stringify(m.vertices),handles=JSON.stringify(cageCorners()),n=Undo.index;DEWCage.begin(Preview.selected,{clientX:500,clientY:300},[2,3,6,7]);DEWCage.scaleBy(1.5);DEWCage.scaleBy(1);DEWCage.finish();return JSON.stringify(m.vertices)==before&&JSON.stringify(cageCorners())==handles&&Undo.index==n;})()`));
	check('Escape cancels a smooth scale without losing an earlier curve',await ev(`(()=>{let before=JSON.stringify(m.vertices),n=Undo.index;DEWCage.begin(Preview.selected,{clientX:500,clientY:300},[2,3,6,7]);DEWCage.scaleBy(1.3);document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return JSON.stringify(m.vertices)==before&&Undo.index==n&&!DEWCage.getDrag()&&Preview.selected.controls.enabled;})()`));
	check('switching to Move preserves the existing curve and uses linear movement',await ev(`(()=>{let before=JSON.parse(JSON.stringify(m.vertices)),bindings=DEWCage.getState().binding.items[0].bindings;BarItems.dew_cage_mode.change('move');DEWCage.begin(Preview.selected,{clientX:500,clientY:300},[0]);DEWCage.moveBy(new THREE.Vector3(2,0,0));DEWCage.finish();return samples.every(({key},i)=>{let b=bindings[i],weight=b.ids.includes(0)?b.weights[b.ids.indexOf(0)]:0;return closePoint(m.vertices[key],[before[key][0]+2*weight,before[key][1],before[key][2]]);});})()`));
	check('whole-cage scaling scales the existing curved geometry normally',await ev(`(()=>{Undo.undo();let before=JSON.parse(JSON.stringify(m.vertices));BarItems.dew_cage_mode.change('scale');scaleCage(1.5,'view',[0,1,2,3,4,5,6,7]);return samples.every(({key})=>closePoint(m.vertices[key],before[key].map(n=>n*1.5)));})()`));
	check('smooth scale does not alter UVs, face topology, material suffix or vertex count',await ev(`(()=>{cylinder();let before=m.getSaveCopy();BarItems.dew_cage_mode.change('smooth_scale');scaleCage();let after=m.getSaveCopy();return JSON.stringify(before.faces)==JSON.stringify(after.faces)&&Object.keys(before.vertices).join()==Object.keys(after.vertices).join()&&after.name=='cylinder.plastic';})()`));
	check('axis-constrained smoothing changes only the requested coordinate',await ev(`(()=>{cylinder();BarItems.dew_cage_mode.change('smooth_scale');scaleCage(2,'x');return samples.every(({key,point,t})=>closePoint(m.vertices[key],[point[0]*(1+ease(t)),point[1],point[2]]));})()`));
	check('a larger cage smooths its transition cell without affecting lower cells',await ev(`(()=>{cylinder();DEWCage.setResolution([2,3,2]);BarItems.dew_cage_mode.change('smooth_scale');scaleCage(2,'view',[4,5,10,11]);return matchesRadius(t=>1+(t<=.5?0:ease((t-.5)*2)));})()`));
	check('selecting every control point keeps an ordinary uniform scale',await ev(`(()=>{cylinder();BarItems.dew_cage_mode.change('smooth_scale');scaleCage(1.5,'view',[0,1,2,3,4,5,6,7]);return samples.every(({key,point})=>closePoint(m.vertices[key],point.map(n=>n*1.5)));})()`));
	// Choose Smooth Scale from the actual mode menu, then scale with the actual X handle.
	await ev('cylinder();true');await sleep(250);
	const selector=await ev(`(()=>{let node=BarItems.dew_cage_mode.nodes.find(n=>n.isConnected&&n.getBoundingClientRect().width).querySelector('.bb-select');let r=node.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
	const press=async p=>{await send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});await send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',buttons:1,clickCount:1});};
	const move=async p=>send('Input.dispatchMouseEvent',{type:'mouseMoved',...p,button:'left',buttons:1});
	const release=async p=>send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});
	await press(selector);await release(selector);
	const option=await ev(`(()=>{let node=[...document.querySelectorAll('.select_menu li')].find(n=>n.textContent.trim()=='Smooth Scale');let r=node.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
	await press(option);await release(option);
	check('choosing Smooth Scale in the mode menu shows the scale gizmo and retains point selection',await ev(`BarItems.dew_cage_mode.value=='smooth_scale'&&DEWCage.getGizmo().root.visible&&[...DEWCage.getState().selected].join()=='2,3,6,7'`));
	const points=await ev(`(()=>{let g=DEWCage.getGizmo();return [.95,1.4].map(t=>projectPoint(g.root.position.clone().add(new THREE.Vector3(g.root.scale.x*t,0,0))));})()`);
	await press(points[0]);await move(points[1]);await release(points[1]);
	check('real gizmo scale uses curved falloff and keeps the other coordinates fixed',await ev(`(()=>{let factor=cageCorners()[7][0]/8;return factor>1.1&&samples.every(({key,point,t})=>closePoint(m.vertices[key],[point[0]*(1+(factor-1)*ease(t)),point[1],point[2]]));})()`));
	await ev(`cylinder();BarItems.dew_cage_mode.change('smooth_scale');true`);await sleep(150);
	const pointDrag=await ev(`(()=>{let s=DEWCage.getState(),pivot=new THREE.Vector3(0,32,0),a=projectPoint(s.controls[7]),b=projectPoint(pivot);return{a,b:{x:b.x+(a.x-b.x)*1.8,y:b.y+(a.y-b.y)*1.8}};})()`);
	await press(pointDrag.a);
	check('direct selected-point scale retains uniform mode with smoothing',await ev(`DEWCage.getDrag()?.smooth&&!DEWCage.getDrag().fromGizmo&&DEWCage.getDrag().axis=='view'`));
	await move(pointDrag.b);await release(pointDrag.b);
	check('real direct point drag produces a round curved taper',await ev(`(()=>{let factor=cageCorners()[7][0]/8;return factor>1.5&&matchesRadius(t=>1+(factor-1)*ease(t));})()`));
	// compileJSON writes five decimal places, including for ordinary unmodified round meshes.
	check('save preserves curved vertices at standard bbmodel precision and excludes cage geometry',await ev(`(()=>{let saved=JSON.parse(Codecs.project.compile()),mesh=saved.elements.find(e=>e.uuid==m.uuid);return saved.elements.length==1&&samples.every(({key})=>mesh.vertices[key].every((n,i)=>n==Math.round(m.vertices[key][i]*100000)/100000))&&!JSON.stringify(saved).includes('Cage preview');})()`));
	await send('Page.enable');
	if(process.env.CAGE_SMOOTH_SCREENSHOT){const capture=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.CAGE_SMOOTH_SCREENSHOT,Buffer.from(capture.result.data,'base64'));}
	check('no renderer exceptions',errors.length==0);
	console.log('RESULT: PASS ('+checks+' checks)');
} finally {ws.close()}
