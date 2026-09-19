// Locator orientation, real viewport picking, preview sizing and export isolation.
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
const send = (method, params = {}) => new Promise(r => {const i = ++id; pending.set(i, r); ws.send(JSON.stringify({id: i, method, params}));});
const ev = async expression => {
	const r = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
	if (r.error || r.result.exceptionDetails) throw Error(JSON.stringify(r));
	return r.result.result.value;
};
const check = (label, ok) => {assert.ok(ok, label); checks++; console.log('PASS ' + label);};
try {
	await send('Runtime.enable');
	await ev(`(() => {
		newProject(Formats.dew_scene);
		Outliner.root.slice().forEach(node => node.remove());
		window.group = new Group({name:'prop.door',origin:[0,0,0]}).init();
		window.locator = new Locator({name:'hinge.door',position:[0,0,0]}).addTo(group).init();
		window.marker = locator.mesh.locator_marker;
		window.preview = Preview.selected;
		BarItems.move_tool.select();unselectAllElements();updateSelection();
		window.front = () => {preview.setProjectionMode(false,true);preview.controls.target.set(0,0,0);preview.camera.position.set(0,0,80);preview.controls.update();preview.render();};
		window.setRotation = r => {locator.rotation.V3_set(r);locator.preview_controller.updateTransform(locator);preview.render();};
		window.projectPoint = v => {const r=preview.canvas.getBoundingClientRect(),p=v.clone().project(preview.camera);return {clientX:r.left+(p.x+1)*r.width/2,clientY:r.top+(1-p.y)*r.height/2};};
		window.markerPoint = (x=.8,y=0,z=0) => projectPoint(marker.localToWorld(new THREE.Vector3(x,y,z)));
		window.tipDirection = () => new THREE.Vector3(1,0,0).transformDirection(marker.matrixWorld);
		window.near = (a,b) => a.every((v,i)=>Math.abs(v-b[i])<1e-5);
		window.arrowLength = () => {const a=markerPoint(0),b=markerPoint(1);return Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);};
		front();
	})()`);
	check('a closed solid arrow has a shallow depth and points along local X', await ev(`(()=>{marker.geometry.computeBoundingBox();const b=marker.geometry.boundingBox;return marker.isMesh&&!marker.isSprite&&b.min.x==0&&b.max.x==1&&Math.abs(b.max.z-b.min.z-.1)<1e-6&&near(tipDirection().toArray(),[1,0,0]);})()`));
	check('front-facing arrow is 44 pixels long and its visible face is pickable', await ev(`Math.abs(arrowLength()-44)<.1&&preview.raycast(markerPoint()).element===locator`));
	check('zoom changes only preview scale and preserves apparent size', await ev(`(()=>{let s=marker.scale.x;preview.camera.position.z=160;preview.controls.update();preview.render();return Math.abs(marker.scale.x/s-2)<1e-5&&Math.abs(arrowLength()-44)<.1&&near(locator.mesh.scale.toArray(),[1,1,1]);})()`));
	check('a 90 degree Z turn points the hinge axis up', await ev(`(()=>{setRotation([0,0,90]);return near(tipDirection().toArray(),[0,1,0]);})()`));
	check('orbiting changes the view but not the arrow orientation', await ev(`(()=>{let q=marker.getWorldQuaternion(new THREE.Quaternion());preview.camera.position.set(60,35,90);preview.controls.update();preview.render();return q.angleTo(marker.getWorldQuaternion(new THREE.Quaternion()))<1e-6;})()`));
	check('parent group rotation is inherited', await ev(`(()=>{group.rotation.V3_set(0,90,0);group.preview_controller.updateTransform(group);setRotation([0,0,0]);let ok=near(tipDirection().toArray(),[0,0,-1]);group.rotation.V3_set(0,0,0);group.preview_controller.updateTransform(group);front();return ok;})()`));
	check('both the back face and the thin edge are pickable', await ev(`(()=>{setRotation([180,0,0]);let back=preview.raycast(markerPoint()).element===locator;setRotation([90,0,0]);let edge=preview.raycast(markerPoint()).element===locator;setRotation([0,0,0]);return back&&edge;})()`));
	check('orthographic zoom preserves size and picking', await ev(`(()=>{preview.setProjectionMode(true,true);preview.render();let first=arrowLength();preview.camera.zoom*=2;preview.camera.updateProjectionMatrix();preview.render();let ok=Math.abs(first-arrowLength())<.1&&preview.raycast(markerPoint()).element===locator;front();return ok;})()`));
	check('picking restores the current view size after another camera rendered', await ev(`(()=>{let point=markerPoint(),size=marker.scale.x;let other=preview.camera.clone();other.position.z*=3;other.updateMatrixWorld();locator.preview_controller.updateWindowSize(locator,{camera:other,height:preview.height});let resized=marker.scale.x>size*2;return resized&&preview.raycast(point).element===locator&&Math.abs(marker.scale.x-size)<1e-6;})()`));
	const point = await ev('markerPoint()');
	const xy = {x:point.clientX,y:point.clientY};
	await send('Input.dispatchMouseEvent', {type:'mouseMoved',...xy});
	await send('Input.dispatchMouseEvent', {type:'mousePressed',...xy,button:'left',buttons:1,clickCount:1});
	await send('Input.dispatchMouseEvent', {type:'mouseReleased',...xy,button:'left',clickCount:1});
	check('clicking the actual arrow selects the locator and highlights it in front', await ev(`locator.selected&&marker.material[0].color.equals(gizmo_colors.outline)&&marker.material.every(m=>!m.depthTest)&&marker.renderOrder==100`));
	check('hidden and locked locators cannot be picked', await ev(`(()=>{unselectAllElements();updateSelection();locator.locked=true;let locked=!preview.raycast(markerPoint());locator.locked=false;locator.visibility=false;locator.preview_controller.updateVisibility(locator);let hidden=!preview.raycast(markerPoint());locator.visibility=true;locator.preview_controller.updateVisibility(locator);return locked&&hidden;})()`));
	check('clean screenshots hide the arrow through a render and restore it afterward', await ev(`(()=>{let hidden=false;Canvas.withoutGizmos(()=>{preview.render();hidden=!marker.visible;});return hidden&&marker.visible;})()`));
	check('rotation undo and redo keep the arrow aligned', await ev(`(()=>{Undo.initEdit({elements:[locator]});setRotation([0,0,90]);Undo.finishEdit('Rotate locator');Undo.undo();let ok=near(tipDirection().toArray(),[1,0,0]);Undo.redo();return ok&&near(tipDirection().toArray(),[0,1,0]);})()`));
	check('bbmodel saves only the real locator transform and no preview geometry', await ev(`(()=>{let saved=JSON.parse(Codecs.project.compile()),e=saved.elements.find(e=>e.uuid==locator.uuid);return saved.elements.length==1&&e.name=='hinge.door'&&near(e.rotation,[0,0,90])&&near(e.position,[0,0,0])&&!e.scale&&!e.vertices;})()`));
	check('glTF exports the locator without marker geometry or a scaled hinge axis', await ev(`(async()=>{let saved=JSON.parse(await Codecs.gltf.compile({encoding:'ascii',animations:false,armature:false,scale:16})),nodes=saved.nodes.filter(n=>n.name=='hinge.door');return nodes.length==1&&nodes[0].mesh===undefined&&(!nodes[0].scale||near(nodes[0].scale,[1,1,1]))&&!saved.meshes;})()`));
	// A simple door gives the reviewer a useful angled preview of the axis and arrow thickness.
	await ev(`(()=>{new Cube({name:'door.metal',from:[1,-16,-1],to:[25,16,1]}).addTo(group).init();locator.position.V3_set(0,4,0);locator.preview_controller.updateTransform(locator);preview.controls.target.set(10,0,0);preview.camera.position.set(50,30,70);preview.controls.update();unselectAllElements();updateSelection();preview.render();})()`);
	if (process.env.LOCATOR_SCREENSHOT) {
		await send('Page.enable');
		const capture = await send('Page.captureScreenshot', {format:'png'});
		fs.writeFileSync(process.env.LOCATOR_SCREENSHOT, Buffer.from(capture.result.data, 'base64'));
	}
	check('removing a locator disposes its marker geometry and materials', await ev(`(()=>{let n=0;marker.geometry.addEventListener('dispose',()=>n++);marker.material.forEach(m=>m.addEventListener('dispose',()=>n++));locator.remove();return n==3&&!Project.nodes_3d[locator.uuid];})()`));
	check('no renderer exceptions', errors.length == 0);
	console.log('RESULT: PASS (' + checks + ' checks)');
} finally {ws.close();}
