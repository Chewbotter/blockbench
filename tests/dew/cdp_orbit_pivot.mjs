// Orbit pivot: selection depth in both projections, and the cursor pivot with nothing selected.
import assert from 'node:assert/strict';
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type == 'page' && t.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0, checks = 0; const pending = new Map(), errors = [];
ws.onmessage = e => {
	const m = JSON.parse(e.data);
	if (m.method == 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
	if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({id: i, method, params})); });
const ev = async expression => {
	const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
	if (r.error || r.result.exceptionDetails) throw Error(r.result.exceptionDetails?.exception?.description ?? JSON.stringify(r));
	return r.result.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (label, ok, detail) => { assert.ok(ok, label + (detail !== undefined ? ': ' + JSON.stringify(detail) : '')); checks++; console.log('PASS ' + label); };
try {
	await send('Runtime.enable');
	// Two cubes at different depths, so a pivot at the wrong one is obvious.
	await ev(`(() => {
		newProject(Formats.free);
		Cube.all.slice().forEach(c => c.remove());
		// Side by side so neither hides the other: the camera looks down -z from z 120, so the
		// cube at z 56..72 is the NEARER one and would occlude the other if they shared x.
		window.deep_cube = new Cube({name:'deep', from:[-24,-8,-8], to:[-8,8,8]}).init();
		window.close_cube = new Cube({name:'close', from:[8,-8,56], to:[24,8,72]}).init();
		let p = Preview.selected;
		p.setProjectionMode(false);
		p.controls.target.set(0,0,0);
		p.camera.position.set(0,0,120);
		p.controls.update(); p.render();
		window.pivotDepth = () => {
			let p = Preview.selected, dir = p.camera.getWorldDirection(new THREE.Vector3());
			return p.controls.target.clone().sub(p.camera.position).dot(dir);
		};
		window.screenOf = point => {
			let p = Preview.selected; p.render();
			let r = p.canvas.getBoundingClientRect(), q = new THREE.Vector3(...point).project(p.camera);
			return {x: r.left + (q.x+1)*r.width/2, y: r.top + (1-q.y)*r.height/2};
		};
		// Orbit on middle click, which is the user's real binding. The stock default is left,
		// and a left press over geometry never reaches the orbit path at all (it selects), so
		// the default would test a gesture that cannot show this behaviour. Live object only,
		// not saved, so the profile keymap is left alone.
		Keybinds.extra.preview_rotate.keybind.set({key: 2});
		unselectAllElements();
		return true;
	})()`);
	await sleep(250);

	// A selection pivots on its CENTRE: close_cube spans z 56..72, centre 64, camera at 120.
	check('the pivot follows a selection in perspective', await ev(`(() => {
		unselectAllElements(); close_cube.select(); updateSelection();
		return Math.abs(pivotDepth() - 56) < 2;
	})()`));

	// The reported bug: a selection made in an orthographic view never moved the pivot, so
	// switching back to perspective orbited around whatever was left over.
	await ev(`(() => {
		unselectAllElements(); updateSelection();
		let p = Preview.selected;
		p.controls.target.set(0,0,0); p.camera.position.set(0,0,120); p.controls.update();
		p.setProjectionMode(true); p.render(); return true;
	})()`);
	await sleep(150);
	check('a selection made in an orthographic view moves the pivot too', await ev(`(() => {
		let before = pivotDepth();
		unselectAllElements(); close_cube.select(); updateSelection();
		return Preview.selected.isOrtho && Math.abs(before - 120) < 2 && Math.abs(pivotDepth() - 56) < 2;
	})()`));
	check('switching back to perspective keeps that pivot', await ev(`(() => {
		Preview.selected.setProjectionMode(false); Preview.selected.render();
		return !Preview.selected.isOrtho && Math.abs(pivotDepth() - 56) < 2;
	})()`));

	// Nothing selected: the pivot used to keep whatever it was last left at.
	await ev(`(() => {
		let p = Preview.selected;
		p.setProjectionMode(false);
		p.controls.target.set(0,0,0); p.camera.position.set(0,0,120); p.controls.update();
		unselectAllElements(); updateSelection(); p.render(); return true;
	})()`);
	await sleep(150);
	check('with nothing selected the pivot is stale until an orbit starts', await ev(`Math.abs(pivotDepth() - 120) < 2`));

	// Aim at each cube's front face, the surface actually facing the camera.
	const onClose = await ev(`JSON.stringify(screenOf([16,0,72]))`);
	const onDeep = await ev(`JSON.stringify(screenOf([-16,0,8]))`);
	// A world point can project off the canvas, and a press that lands outside does nothing at
	// all, which reads as a broken feature rather than a broken aim. Fail on the aim instead.
	check('both aim points land on the canvas, over the cube they target', await ev(`(() => {
		let p = Preview.selected, canvas = p.canvas;
		return [[${onClose}, 'close'], [${onDeep}, 'deep']].every(([pt, name]) => {
			if (document.elementFromPoint(pt.x, pt.y) !== canvas) return false;
			let r = canvas.getBoundingClientRect();
			p.raycaster.setFromCamera(new THREE.Vector2((pt.x - r.left) / r.width * 2 - 1, -((pt.y - r.top) / r.height) * 2 + 1), p.camera);
			return p.raycaster.intersectObjects([window[name + '_cube'].mesh], false).length > 0;
		});
	})()`));
	const onEmpty = await ev(`JSON.stringify((()=>{let r=Preview.selected.canvas.getBoundingClientRect();return {x:r.left+12,y:r.top+12};})())`);
	const orbitAt = async point => {
		const p = JSON.parse(point);
		await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: p.x, y: p.y});
		await send('Input.dispatchMouseEvent', {type: 'mousePressed', x: p.x, y: p.y, button: 'middle', buttons: 4, clickCount: 1});
		await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: p.x, y: p.y, button: 'middle', buttons: 0, clickCount: 1});
		await sleep(120);
	};

	// The pivot takes its depth from the MIDDLE of the screen, the line it sits on, not from under the cursor:
	// a depth taken under the cursor put the pivot in mid-air beside whatever was in the middle (reported on the
	// soldier, 2026-09-21). Looking straight at the close cube, its front face z 72 from z 120 is a depth of 48,
	// where selecting that same cube gives its centre, 56. Where the orbit is started from changes nothing.
	const lookAt = async x => { await ev(`(() => { let p = Preview.selected; p.camera.position.set(${x}, 0, 120); p.controls.target.set(${x}, 0, 60); p.controls.update(); p.render(); return true; })()`); await sleep(120); };
	await lookAt(16);
	const aims = {close: await ev(`JSON.stringify(screenOf([16,0,72]))`), deep: await ev(`JSON.stringify(screenOf([-16,0,8]))`), empty: onEmpty};
	for (let from of ['close', 'deep', 'empty']) {
		await ev(`(() => { let p = Preview.selected; p.controls.target.set(16, 0, 60); p.controls.update(); return true; })()`);
		await orbitAt(aims[from]);
		check('looking at the close cube the pivot sits on its surface, orbit started over ' + from, await ev(`Math.abs(pivotDepth() - 48) < 3`), await ev(`pivotDepth()`));
	}
	await lookAt(-16);
	// Started from the corner of the canvas: from here the close cube projects off it, and a press that lands
	// outside the canvas does nothing at all (the trap this file already guards against above)
	await orbitAt(onEmpty);
	check('looking at the deep cube gives the deeper pivot', await ev(`Math.abs(pivotDepth() - 112) < 3`), await ev(`pivotDepth()`));

	// The middle of the screen is a gap: the first ring of rays around it that meets a surface decides. From
	// x -2 the deep cube's edge (x -8) is just left of the middle and the close cube well to the right.
	await lookAt(-2);
	check('with a gap in the middle the centre ray meets nothing', await ev(`(() => { let p = Preview.selected; p.raycaster.setFromCamera(new THREE.Vector2(0, 0), p.camera);
		return p.raycaster.intersectObjects(OrbitPivot.pivotSurfaces(), false).length == 0; })()`));
	await orbitAt(onEmpty);
	check('and the pivot takes the surface nearest the middle', await ev(`Math.abs(pivotDepth() - 112) < 3`), await ev(`pivotDepth()`));

	// A hidden element takes no part at all: hide the deep cube and the same view now finds the close one
	await ev(`(() => { deep_cube.visibility = false; Canvas.updateVisibility(); Preview.selected.render(); return true; })()`);
	check('a hidden element is not a pivot surface', await ev(`!OrbitPivot.pivotSurfaces().includes(deep_cube.mesh) && OrbitPivot.pivotSurfaces().includes(close_cube.mesh)`));
	await orbitAt(onEmpty);
	check('hiding it takes it out of the orbit: the pivot moves to what is still shown', await ev(`Math.abs(pivotDepth() - 48) < 3`), await ev(`pivotDepth()`));
	await ev(`(() => { deep_cube.visibility = true; Canvas.updateVisibility(); Preview.selected.render(); return true; })()`);

	// Nothing on any ray: fall back to the boxes of what is in the frustum. From 40 up, looking level, the deep
	// cube sits at the bottom edge of the frame, outside the widest ring, and the close one is out of frame:
	// the box centre is the deep cube's own, z 0, a depth of 120.
	await ev(`(() => { let p = Preview.selected; p.camera.position.set(-16, 40, 120); p.controls.target.set(-16, 40, 60); p.controls.update(); p.render(); return true; })()`);
	await sleep(120);
	await orbitAt(onEmpty);
	check('with no surface near the middle the pivot falls back to the centre of what is in view', await ev(`OrbitPivot.surfaceInView(Preview.selected) === null && Math.abs(pivotDepth() - 120) < 3`), await ev(`JSON.stringify({depth: pivotDepth(), surface: !!OrbitPivot.surfaceInView(Preview.selected), centre: OrbitPivot.viewCenter(Preview.selected)})`));
	check('the view centre ignores the depth of things out of frame', await ev(`(() => {
		// Look at the deep cube alone: the close one is behind the camera now.
		let p = Preview.selected;
		p.camera.position.set(-16, 0, 40); p.controls.target.set(-16, 0, 0);
		p.controls.update(); p.render();
		let center = OrbitPivot.viewCenter(p);
		return center && Math.abs(center.z - 0) < 2 && Math.abs(center.x + 16) < 2;
	})()`));
	check('an empty view leaves the pivot alone', await ev(`(() => {
		let p = Preview.selected;
		// Point the camera away from everything.
		p.camera.position.set(0, 0, 400); p.controls.target.set(0, 0, 500);
		p.camera.lookAt(new THREE.Vector3(0, 0, 900)); p.camera.updateMatrixWorld(); p.render();
		let before = p.controls.target.clone();
		let moved = OrbitPivot.pivotForOrbit(p);
		return OrbitPivot.viewCenter(p) === null && moved === false && p.controls.target.equals(before);
	})()`));
	// Put the view back for the checks that follow.
	await ev(`(() => {
		let p = Preview.selected;
		p.camera.position.set(0,0,120); p.controls.target.set(0,0,0);
		p.camera.lookAt(new THREE.Vector3(0,0,0)); p.controls.update(); p.render(); return true;
	})()`);
	await sleep(150);

	check('a selection still wins over the cursor', await ev(`(() => {
		unselectAllElements(); close_cube.select(); updateSelection();
		return Math.abs(pivotDepth() - 56) < 2;
	})()`));
	await orbitAt(onDeep);
	check('with a selection, orbiting over something else does not steal the pivot', await ev(`Math.abs(pivotDepth() - 56) < 2`));

	check('the setting still turns the whole thing off', await ev(`(() => {
		let stock = settings.orbit_around_selection.value;
		try {
			settings.orbit_around_selection.value = false;
			let p = Preview.selected;
			p.controls.target.set(0,0,0); p.camera.position.set(0,0,120); p.controls.update();
			unselectAllElements(); close_cube.select(); updateSelection();
			let unmoved = Math.abs(pivotDepth() - 120) < 2;
			unselectAllElements(); updateSelection();
			return unmoved && OrbitPivot.pivotForOrbit(p) === false;
		} finally { settings.orbit_around_selection.value = stock; }
	})()`));

	check('no renderer exceptions', errors.length == 0);
	console.log('RESULT: PASS (' + checks + ' checks)');
} finally { ws.close(); }
