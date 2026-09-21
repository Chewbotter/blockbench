import { THREE } from '../lib/libs';
// getSelectionCenter is used through its global: importing the transform module here would
// reorder bundle evaluation and break the canvas setup.

/**
 * Orbit pivot. The pivot of every preview slides along its line of sight to the depth of what
 * you are working on: the selection when there is one, otherwise the surface under the cursor
 * at the moment an orbit starts. Sliding along the line of sight means nothing on screen moves,
 * it only changes what the next orbit revolves around.
 */

// The pivot never comes closer to the camera than this (a point behind or at the camera is ignored)
const MIN_PIVOT_DISTANCE = 1;

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

/** Nearest visible element surface under the pointer, in world space, or null. */
function surfaceUnderCursor(preview, event: MouseEvent): THREE.Vector3 {
	if (!preview?.canvas || !preview.raycaster) return null;
	let rect = preview.canvas.getBoundingClientRect();
	if (!rect.width || !rect.height) return null;
	let mouse = new THREE.Vector2(
		((event.clientX - rect.left) / rect.width) * 2 - 1,
		-((event.clientY - rect.top) / rect.height) * 2 + 1
	);
	preview.raycaster.setFromCamera(mouse, preview.camera);
	let objects = [];
	for (let element of Outliner.elements) {
		// Only real surfaces: no outlines, vertex points or gizmo helpers to pivot on.
		if (element.visibility === false || element.locked) continue;
		let mesh = element.mesh;
		// isMesh, not type: Blockbench overwrites Object3D.type with its own name ('cube',
		// 'mesh'), so testing for 'Mesh' matched nothing and every raycast came back empty.
		if (mesh && mesh.isMesh && mesh.geometry && mesh.visible) objects.push(mesh);
	}
	if (!objects.length) return null;
	let hits = preview.raycaster.intersectObjects(objects, false);
	return hits.length ? hits[0].point : null;
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
	for (let element of Outliner.elements) {
		// Helpers marked export = false (the scale figure, the mannequin) are not what you are
		// looking at, and the tile tools already ignore them.
		if (element.visibility === false || element.export === false) continue;
		let mesh = element.mesh;
		if (!mesh || !mesh.isMesh || !mesh.geometry || !mesh.visible) continue;
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
 * is why orbiting felt like it came from nowhere. In order: the surface under the cursor, then
 * the centre of whatever is in view. A selection still wins over both, and with an empty view
 * there is nothing sensible to pick, so the pivot is left as it was.
 */
function pivotUnderCursor(preview, event: MouseEvent): boolean {
	if (!settings.orbit_around_selection.value) return false;
	if (Modes.display || hasSelection()) return false;
	let point = surfaceUnderCursor(preview, event) || viewCenter(preview);
	return point ? setPivotDepth(preview, point) : false;
}

Blockbench.on('update_selection', updateOrbitPivots);

// Global rather than an import: OrbitControls is evaluated before this module, and importing
// either way round would reorder the bundle (see the note at the top of the file).
Object.assign(window, {OrbitPivot: {updateOrbitPivots, pivotUnderCursor, surfaceUnderCursor, viewCenter, setPivotDepth, MIN_PIVOT_DISTANCE}});
