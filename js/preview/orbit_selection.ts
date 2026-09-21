import { THREE } from '../lib/libs';
// getSelectionCenter is used through its global: importing the transform module here would
// reorder bundle evaluation and break the canvas setup.

/**
 * Orbit pivot. The pivot of every preview slides along its line of sight to the depth of what
 * you are working on: the selection when there is one, otherwise the visible surface in the
 * middle of the screen at the moment an orbit starts. Sliding along the line of sight means
 * nothing on screen moves, it only changes what the next orbit revolves around.
 *
 * The depth comes from the MIDDLE of the screen, not from under the cursor. The pivot always sits
 * on the line through the middle of the screen, so a depth taken anywhere else makes a pivot that
 * is on nothing: with the cursor over a torso behind a forearm, the pivot hung in mid-air at the
 * torso's depth and the forearm swung across the screen (reported on soldier_male_rigged.bbmodel,
 * 2026-09-21: after Center View on Selection and a deselect the pivot jumped 4.6 to 6.5 units
 * behind a face 20 units away). Hidden elements never take part, in any of the steps.
 */

// The pivot never comes closer to the camera than this (a point behind or at the camera is ignored)
const MIN_PIVOT_DISTANCE = 1;
// When the very middle of the screen is a gap (between an arm and the body), rays go out in rings
// around it, as fractions of the half screen, and the first ring that meets a surface decides
const PIVOT_RINGS = [0.15, 0.35, 0.6];
const PIVOT_RING_POINTS = 8;

/**
 * Put the pivot at the depth of `point`, measured along the way the camera faces.
 *
 * Orthographic previews are included. Moving the pivot along the view direction cannot change an
 * orthographic image, so this is free there, and leaving it out was a bug: a selection made in
 * ortho never moved the pivot, so switching back to perspective orbited around a stale point
 * until "center view on selection" was pressed. A locked side view is safe too, since
 * setLockedAngle forces the two components across the view and this only writes the third.
 */
function setPivotDepth(preview, point: THREE.Vector3): boolean {
	if (!preview.controls) return false;
	let camera = preview.camera;
	let direction = camera.getWorldDirection(new THREE.Vector3());
	let depth = point.clone().sub(camera.position).dot(direction);
	if (!(depth >= MIN_PIVOT_DISTANCE)) return false;
	preview.controls.target.copy(camera.position).addScaledVector(direction, depth);
	return true;
}

function hasSelection(): boolean {
	return !!(Outliner.selected.length || Group.first_selected);
}

function updateOrbitPivots() {
	if (!settings.orbit_around_selection.value) return;
	if (Modes.display) return;
	if (!hasSelection()) return;

	let center = new THREE.Vector3().fromArray(getSelectionCenter()).add(scene.position);
	for (let preview of Preview.all) {
		if (!preview.controls?.enabled) continue;
		setPivotDepth(preview, center);
	}
}

/** The surfaces a pivot may sit on: visible, exported elements with real geometry. */
function pivotSurfaces(): THREE.Object3D[] {
	let objects = [];
	for (let element of Outliner.elements) {
		// Only real surfaces: no outlines, vertex points or gizmo helpers to pivot on. A hidden element
		// is out entirely, so hiding something takes it out of the camera's reckoning as well, and so is
		// a helper marked export = false (the scale figure), as the tile tools already treat it.
		if (element.visibility === false || element.export === false) continue;
		let mesh = element.mesh;
		// isMesh, not type: Blockbench overwrites Object3D.type with its own name ('cube',
		// 'mesh'), so testing for 'Mesh' matched nothing and every raycast came back empty.
		if (mesh && mesh.isMesh && mesh.geometry && mesh.visible) objects.push(mesh);
	}
	return objects;
}

/**
 * The visible surface in the middle of the screen, in world space, or null: the point the pivot's
 * own line meets. When the middle is a gap, the nearest surface of the first ring around it that
 * meets anything.
 */
function surfaceInView(preview): THREE.Vector3 {
	if (!preview?.camera || !preview.raycaster) return null;
	let objects = pivotSurfaces();
	if (!objects.length) return null;
	let nearest = (x: number, y: number) => {
		preview.raycaster.setFromCamera(new THREE.Vector2(x, y), preview.camera);
		let hits = preview.raycaster.intersectObjects(objects, false);
		return hits.length ? hits[0] : null;
	};
	let centre = nearest(0, 0);
	if (centre) return centre.point;
	for (let radius of PIVOT_RINGS) {
		let best = null;
		for (let i = 0; i < PIVOT_RING_POINTS; i++) {
			let angle = i / PIVOT_RING_POINTS * Math.PI * 2;
			let hit = nearest(Math.cos(angle) * radius, Math.sin(angle) * radius);
			if (hit && (!best || hit.distance < best.distance)) best = hit;
		}
		if (best) return best.point;
	}
	return null;
}

/**
 * Centre of the visible geometry inside the camera frustum, or null when the view is empty.
 * Bounding boxes, not vertices: this runs as an orbit starts and a scene can be large.
 */
function viewCenter(preview): THREE.Vector3 {
	let camera = preview.camera;
	camera.updateMatrixWorld();
	let frustum = new THREE.Frustum().setFromProjectionMatrix(
		new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
	);
	let box = new THREE.Box3(), found = false;
	for (let mesh of pivotSurfaces() as THREE.Mesh[]) {
		mesh.updateMatrixWorld();
		if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
		let bounds = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
		if (bounds.isEmpty() || !frustum.intersectsBox(bounds)) continue;
		box.union(bounds); found = true;
	}
	return found ? box.getCenter(new THREE.Vector3()) : null;
}

/**
 * Called as an orbit begins. With nothing selected there was no rule at all: the pivot kept
 * whatever it was last left at, by an old selection, a pan, or the view the file opened in, which
 * is why orbiting felt like it came from nowhere. In order: the surface in the middle of the
 * screen (surfaceInView), then the centre of the boxes of whatever is in view, which is coarse (one
 * big mesh seen close up answers with its own middle) and so only the last resort. A selection
 * still wins over both, and with an empty view there is nothing sensible to pick, so the pivot is
 * left as it was. Where the pointer is plays no part: see the note at the top.
 */
function pivotForOrbit(preview): boolean {
	if (!settings.orbit_around_selection.value) return false;
	if (Modes.display || hasSelection()) return false;
	let point = surfaceInView(preview) || viewCenter(preview);
	return point ? setPivotDepth(preview, point) : false;
}

Blockbench.on('update_selection', updateOrbitPivots);

// Global rather than an import: OrbitControls is evaluated before this module, and importing
// either way round would reorder the bundle (see the note at the top of the file).
Object.assign(window, {OrbitPivot: {updateOrbitPivots, pivotForOrbit, surfaceInView, pivotSurfaces, viewCenter, setPivotDepth, MIN_PIVOT_DISTANCE, PIVOT_RINGS, PIVOT_RING_POINTS}});
