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
const check = (label, ok) => { assert.ok(ok, label); checks++; console.log('PASS ' + label); };
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
			let hit = OrbitPivot.surfaceUnderCursor(p, {clientX: pt.x, clientY: pt.y});
			return !!hit && p.raycaster.intersectObjects([window[name + '_cube'].mesh], false).length > 0;
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

	// The cursor pivots on the SURFACE under it, not an object centre: front face z 72 from a
	// camera at z 120 is a depth of 48, where selecting that same cube gives 56.
	await orbitAt(onClose);
	check('starting an orbit over a cube pivots on the surface under the cursor', await ev(`Math.abs(pivotDepth() - 48) < 3`));
	await orbitAt(onDeep);
	check('a cube further away gives the deeper pivot', await ev(`Math.abs(pivotDepth() - 112) < 3`));

	const before_empty = await ev(`pivotDepth()`);
	await orbitAt(onEmpty);
	check('over empty space the pivot is left alone', await ev(`Math.abs(pivotDepth() - ${before_empty}) < 0.001`));

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
			return unmoved && OrbitPivot.pivotUnderCursor(p, {clientX:0, clientY:0}) === false;
		} finally { settings.orbit_around_selection.value = stock; }
	})()`));

	check('no renderer exceptions', errors.length == 0);
	console.log('RESULT: PASS (' + checks + ' checks)');
} finally { ws.close(); }
