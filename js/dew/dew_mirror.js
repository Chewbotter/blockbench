// Live Mirror: see the other half of what you are modelling, in real time, without it being there. The stock Mirror
// Modeling repeats every edit on a real second half while it is on, which is slow and edits things you did not ask for.
// This one only DRAWS the selected element again, flipped across its own pivot on a chosen axis:
//   - the preview is a second draw of the element's own GPU geometry with a negative scale, so it follows every drag,
//     edit and posed deformation for free, and it is in no pick list, so it cannot be clicked or selected
//   - click away, work on something else: the mirror stays until it is dealt with, from a small bar in the viewport:
//     Discard drops it, Copy makes it a real element exactly where it shows, Combine adds the mirrored half into the
//     same mesh, welding vertices that meet and dropping faces that lie flat on the mirror plane (they would be walls
//     inside the solid)
//   - Lock Seam (on by default) keeps vertices that sit on the mirror plane ON it, so the halves combine cleanly
// The mirror is across the element's OWN axis through its pivot (local space), which is the world axis for anything
// unrotated. Mirrors are kept per project by element uuid, in memory only: a working aid like the cage, never saved.
import { THREE } from "../lib/libs";

export const MIRROR = {
	PLANE_EPSILON: 0.001,	// a vertex this close to the mirror plane is on it: shared by both halves, held by Lock Seam
	WELD_DISTANCE: 0.001,	// Combine: a mirrored vertex this close to an existing one becomes that vertex
	REMOVE_FACES_ON_PLANE: true,	// Combine drops faces lying flat on the mirror plane
	COPY_SUFFIX: '_mirror',	// for a copy whose name has no left / right to flip
	NAME: 'dew_mirror',
};
const AXES = ['x', 'y', 'z'];
const registry = new WeakMap();	// ModelProject -> Map(element uuid -> {axis, seam: Set of vertex keys})
const previews = new Set();		// every preview object made, so stale ones can be found and removed

const mirrors = () => { if (!Project) return new Map(); if (!registry.has(Project)) registry.set(Project, new Map()); return registry.get(Project); };
const mirrorable = element => element instanceof Mesh || element instanceof Cube;
export function getMirror(element) { return element ? mirrors().get(element.uuid) || null : null; }

// The elements the bar's buttons act on: the selected ones that have a mirror, else every mirror there is, so the
// buttons work "at any time", whatever is selected
export function targets() {
	let map = mirrors();
	let selected = Outliner.selected.filter(element => map.has(element.uuid));
	if (selected.length) return selected;
	return [...map.keys()].map(uuid => OutlinerNode.uuids[uuid]).filter(element => element && Outliner.elements.includes(element));
}

// Vertices on the mirror plane. The set only grows while the mirror lives: a vertex being dragged off the plane is
// no longer near it by the time anyone looks, so it has to be remembered from before.
function gatherSeam(element, entry) {
	if (!(element instanceof Mesh)) return;
	for (let vkey in element.vertices) if (Math.abs(element.vertices[vkey][entry.axis]) <= MIRROR.PLANE_EPSILON) entry.seam.add(vkey);
}
function holdSeam(element, entry) {
	if (!(element instanceof Mesh) || !BarItems.dew_mirror_lock_seam || !BarItems.dew_mirror_lock_seam.value) return;
	gatherSeam(element, entry);
	for (let vkey of entry.seam) {
		let vertex = element.vertices[vkey];
		if (!vertex) { entry.seam.delete(vkey); continue; }
		vertex[entry.axis] = 0;
	}
}
// Before every geometry rebuild, so what is drawn, what the gizmo reads next and what the edit finally stores agree
const controller = Mesh.preview_controller, innerUpdateGeometry = controller.updateGeometry;
controller.updateGeometry = function(element, ...rest) {
	let entry = getMirror(element);
	if (entry) holdSeam(element, entry);
	return innerUpdateGeometry.call(this, element, ...rest);
};

// The preview: the element's own geometry and materials drawn again under its scene object, flipped
function syncPreviews() {
	let map = mirrors();
	for (let [uuid, entry] of map) {
		let element = OutlinerNode.uuids[uuid];
		if (!element || !Outliner.elements.includes(element) || !element.mesh) { if (!element || !Outliner.elements.includes(element)) map.delete(uuid); continue; }
		let host = element.mesh, preview = host.children.find(child => child.name == MIRROR.NAME);
		if (!preview) {
			preview = new THREE.Mesh(host.geometry, host.material);
			preview.name = MIRROR.NAME;
			preview.no_export = true;		// the glTF exporter skips it
			preview.raycast = () => {};		// and no ray ever meets it, whoever casts recursively
			host.add(preview);
			previews.add(preview);
		}
		if (preview.geometry !== host.geometry) preview.geometry = host.geometry;
		if (preview.material !== host.material) preview.material = host.material;
		preview.frustumCulled = false;
		preview.renderOrder = host.renderOrder;
		preview.scale.set(entry.axis == 0 ? -1 : 1, entry.axis == 1 ? -1 : 1, entry.axis == 2 ? -1 : 1);
		preview.userData.mirror_of = uuid;
	}
	// A preview whose element lost its mirror, was rebuilt on a new scene object, or belongs to a project that is not
	// open right now goes; coming back to that project makes it again, which costs nothing (it owns no geometry)
	for (let preview of previews) {
		let element = OutlinerNode.uuids[preview.userData.mirror_of];
		if (map.has(preview.userData.mirror_of) && element && preview.parent && element.mesh === preview.parent) continue;
		if (preview.parent) preview.parent.remove(preview);
		previews.delete(preview);
	}
}
let hooked = false;
function hookRender() {
	if (hooked || !Canvas.scene) return;
	hooked = true;
	let inner = Canvas.scene.onBeforeRender;
	Canvas.scene.onBeforeRender = function(...args) { syncPreviews(); if (inner) return inner.apply(this, args); };
}

export function setMirror(element, axis) {
	if (!mirrorable(element)) return false;
	hookRender();
	let entry = {axis, seam: new Set()};
	gatherSeam(element, entry);
	mirrors().set(element.uuid, entry);
	refresh();
	return true;
}
export function discardMirror(element) {
	mirrors().delete(element.uuid);
	refresh();
}
function refresh() {
	syncPreviews();
	updateBar();
	Preview.all.forEach(preview => preview.render && preview.offscreen !== true && preview.canvas.isConnected && preview.render());
}

// .L <-> .R, _l <-> _r and so on for bone names: the mirrored half of a rigged mesh belongs to the other side's bones
export function otherSide(bone, bones) {
	let swaps = [[/\.L$/, '.R'], [/\.R$/, '.L'], [/_L$/, '_R'], [/_R$/, '_L'], [/\.l$/, '.r'], [/\.r$/, '.l'], [/_l$/, '_r'], [/_r$/, '_l'], [/Left/, 'Right'], [/Right/, 'Left'], [/left/, 'right'], [/right/, 'left']];
	for (let [from, to] of swaps) if (from.test(bone.name)) { let twin = bones.find(other => other.name == bone.name.replace(from, to)); if (twin) return twin; }
	return bone;
}
function armatureBones(mesh) { let armature = mesh.getArmature && mesh.getArmature(); return armature ? armature.getAllBones() : []; }

// Copy: the mirror becomes its own element, exactly where it shows
export function copyMirror(element) {
	let entry = getMirror(element);
	if (!entry) return null;
	let axis = entry.axis, copy = new element.constructor(element), name = element.name;
	copy.sortInBefore(element, 1).init();	// first: Cube.flip refreshes the cube's scene object, which init makes
	if (element instanceof Cube) {
		let rotation = element.rotation.slice();
		copy.flip(axis, copy.origin[axis]);	// from, to and the face uvs; about its own pivot, so the pivot stays
		copy.rotation.V3_set(rotation);		// flip is a mirror in the parent's space and turns the cube; this one is in the cube's own
	} else {
		for (let vkey in copy.vertices) copy.vertices[vkey][axis] *= -1;
		for (let fkey in copy.faces) copy.faces[fkey].invert();
		flipNameOnAxis(copy, axis);
	}
	if (copy.name == name) copy.name = name + MIRROR.COPY_SUFFIX;
	if (element instanceof Mesh) {
		let bones = armatureBones(element);
		for (let bone of bones) for (let vkey in element.vertices) {
			let weight = bone.getVertexWeight(element, vkey);
			if (weight) otherSide(bone, bones).setVertexWeight(copy, vkey, weight);
		}
	}
	return copy;
}

// Combine: the mirrored half joins the same mesh
export function combineMirror(mesh) {
	let entry = getMirror(mesh);
	if (!entry || !(mesh instanceof Mesh)) return null;
	let axis = entry.axis, grid = 1 / MIRROR.WELD_DISTANCE;
	let key = p => Math.round(p[0] * grid) + ',' + Math.round(p[1] * grid) + ',' + Math.round(p[2] * grid);
	let original_keys = Object.keys(mesh.vertices), at = new Map();
	for (let vkey of original_keys) { let p = mesh.vertices[vkey]; if (Math.abs(p[axis]) <= MIRROR.PLANE_EPSILON) p[axis] = 0; at.set(key(p), vkey); }
	// Where each vertex lands: on itself when it is on the plane, on a vertex already standing there, else a new one
	let twin = {}, added = [];
	for (let vkey of original_keys) {
		let p = mesh.vertices[vkey], mirrored = p.slice(); mirrored[axis] = -mirrored[axis];
		let existing = at.get(key(mirrored));
		if (existing) { twin[vkey] = existing; continue; }
		twin[vkey] = mesh.addVertices(mirrored)[0];
		added.push([vkey, twin[vkey]]);
	}
	let face_id = vertices => vertices.slice().sort().join('|');
	let standing = new Set(Object.values(mesh.faces).map(face => face_id(face.vertices)));
	let stats = {vertices_added: added.length, vertices_welded: original_keys.length - added.length, faces_added: 0, faces_on_plane_removed: 0, faces_skipped: 0};
	for (let [fkey, face] of Object.entries(mesh.faces)) {
		let mapped = face.vertices.map(vkey => twin[vkey]);
		if (face.vertices.length >= 3 && mapped.every((vkey, i) => vkey == face.vertices[i])) {
			if (MIRROR.REMOVE_FACES_ON_PLANE) { delete mesh.faces[fkey]; stats.faces_on_plane_removed++; }
			continue;
		}
		if (new Set(mapped).size != mapped.length || standing.has(face_id(mapped))) { stats.faces_skipped++; continue; }
		let uv = {}; face.vertices.forEach((vkey, i) => { uv[mapped[i]] = (face.uv[vkey] || [0, 0]).slice(); });
		let mirrored_face = new MeshFace(mesh, face).extend({vertices: mapped, uv});
		mirrored_face.invert();
		mesh.addFaces(mirrored_face);
		standing.add(face_id(mapped));
		stats.faces_added++;
	}
	let bones = armatureBones(mesh);
	for (let bone of bones) for (let [source, target] of added) {
		let weight = bone.getVertexWeight(mesh, source);
		if (weight) otherSide(bone, bones).setVertexWeight(mesh, target, weight);
	}
	return stats;
}

// The bar in the viewport, there while the project has a mirror
let bar = null;
function updateBar() {
	let host = document.getElementById('preview');
	if (!host) return;
	let list = targets(), any = mirrors().size > 0 && Modes.edit;
	if (!bar) {
		bar = Interface.createElement('div', {id: 'dew_mirror_bar'});
		host.append(bar);
	}
	bar.style.display = any ? 'flex' : 'none';
	if (!any) return;
	bar.innerHTML = '';
	let names = list.map(element => element.name), axes = [...new Set(list.map(element => AXES[getMirror(element).axis].toUpperCase()))];
	bar.append(Interface.createElement('span', {class: 'dew_mirror_label', title: names.join(', ')}, 'Mirror ' + axes.join(' ') + ': ' + (names.length == 1 ? names[0] : names.length + ' objects')));
	for (let id of ['dew_mirror_discard', 'dew_mirror_copy', 'dew_mirror_combine']) {
		let action = BarItems[id];
		let button = Interface.createElement('button', {title: action.description}, action.name);
		button.addEventListener('click', event => { event.stopPropagation(); action.trigger(event); });
		bar.append(button);
	}
	let lock = BarItems.dew_mirror_lock_seam;
	let box = Interface.createElement('input', {type: 'checkbox', id: 'dew_mirror_lock_box'}); box.checked = !!lock.value;
	box.addEventListener('change', () => { if (lock.value != box.checked) lock.trigger(); });
	bar.append(Interface.createElement('label', {title: lock.description, for: 'dew_mirror_lock_box'}, [box, 'Lock Seam']));
}
Blockbench.addCSS(`
	#dew_mirror_bar { position: absolute; top: 6px; left: 50%; transform: translateX(-50%); z-index: 3; display: none; align-items: center; gap: 6px; padding: 3px 8px; background: var(--color-ui); border: 1px solid var(--color-border); border-radius: 4px; font-size: 13px; }
	#dew_mirror_bar .dew_mirror_label { color: var(--color-subtle_text); margin-right: 4px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	#dew_mirror_bar button { height: 24px; line-height: 22px; padding: 0 9px; min-width: 0; }
	#dew_mirror_bar label { display: flex; align-items: center; gap: 4px; margin: 0 0 0 4px; cursor: pointer; }
`);

BARS.defineActions(function() {
	let usable = () => Modes.edit && Outliner.selected.some(mirrorable);
	AXES.forEach((letter, axis) => new Action('dew_mirror_' + letter, {
		name: 'Live Mirror ' + letter.toUpperCase(),
		description: 'Show the selected mesh or cube mirrored across its own ' + letter.toUpperCase() + ' axis at its pivot, updating as you work. The mirror is only drawn: it cannot be selected, and nothing you do to other things touches it. Click again to drop it',
		icon: 'flip',
		color: letter,
		category: 'edit',
		condition: usable,
		click() {
			for (let element of Outliner.selected.filter(mirrorable)) {
				let entry = getMirror(element);
				if (entry && entry.axis == axis) discardMirror(element); else setMirror(element, axis);
			}
		}
	}));
	new Action('dew_mirror', {
		name: 'Live Mirror',
		description: 'Show the selected mesh or cube mirrored across its own X axis at its pivot, updating as you work. The arrow has the other axes and what to do with the mirror',
		icon: 'flip',
		category: 'edit',
		condition: usable,
		click() { BarItems.dew_mirror_x.click(); },
		side_menu: new Menu('dew_mirror', ['dew_mirror_x', 'dew_mirror_y', 'dew_mirror_z', '_', 'dew_mirror_discard', 'dew_mirror_copy', 'dew_mirror_combine', '_', 'dew_mirror_lock_seam']),
	});
	let exists = () => Modes.edit && mirrors().size > 0;
	new Action('dew_mirror_discard', {
		name: 'Discard',
		description: 'Drop the mirror. Nothing was ever there, so nothing changes',
		icon: 'close',
		category: 'edit',
		condition: exists,
		click() { targets().forEach(discardMirror); }
	});
	new Action('dew_mirror_copy', {
		name: 'Copy',
		description: 'Turn the mirror into its own object, exactly where it shows',
		icon: 'content_copy',
		category: 'edit',
		condition: exists,
		click() {
			let list = targets();
			if (!list.length) return;
			Undo.initEdit({elements: [], outliner: true, selection: true});
			let copies = list.map(copyMirror).filter(Boolean);
			list.forEach(element => mirrors().delete(element.uuid));
			unselectAllElements(); copies.forEach(copy => copy.markAsSelected());
			Undo.finishEdit('Copy mirror', {elements: copies, outliner: true, selection: true});
			Canvas.updateView({elements: copies, element_aspects: {geometry: true, faces: true, uv: true, transform: true}, selection: true});
			refresh();
		}
	});
	new Action('dew_mirror_combine', {
		name: 'Combine',
		description: 'Make the mirror real and part of the same mesh: the mirrored half is added, vertices that meet are welded, and faces lying flat on the mirror plane are dropped. A cube cannot hold two boxes, so a cube gets a copy instead',
		icon: 'join_full',
		category: 'edit',
		condition: exists,
		click() {
			let list = targets(), meshes = list.filter(element => element instanceof Mesh), cubes = list.filter(element => element instanceof Cube);
			if (!list.length) return;
			let bones = []; meshes.forEach(mesh => bones.safePush(...armatureBones(mesh)));
			Undo.initEdit({elements: [...meshes, ...bones], outliner: true, selection: true});
			let stats = meshes.map(combineMirror).filter(Boolean);
			let copies = cubes.map(copyMirror).filter(Boolean);
			list.forEach(element => mirrors().delete(element.uuid));
			Undo.finishEdit('Combine mirror', {elements: [...meshes, ...bones, ...copies], outliner: true, selection: true});
			Canvas.updateView({elements: [...meshes, ...copies], element_aspects: {geometry: true, faces: true, uv: true, transform: true}, selection: true});
			refresh();
			if (stats.length) {
				let total = stats.reduce((sum, s) => ({welded: sum.welded + s.vertices_welded, dropped: sum.dropped + s.faces_on_plane_removed}), {welded: 0, dropped: 0});
				Blockbench.showQuickMessage(`Combined: ${total.welded} vertices welded` + (total.dropped ? `, ${total.dropped} faces on the mirror plane dropped` : '') + (cubes.length ? '. Cubes got a copy' : ''), 2500);
			} else if (cubes.length) Blockbench.showQuickMessage('A cube cannot hold two boxes: copied instead', 2500);
		}
	});
	new Toggle('dew_mirror_lock_seam', {
		name: 'Lock Seam',
		description: 'While a mesh has a live mirror, vertices sitting on the mirror plane stay on it: they slide along the seam but cannot leave it, so the two halves combine cleanly',
		icon: 'vertical_align_center',
		category: 'edit',
		default: true,
		onChange() { updateBar(); }
	});
});
for (let event of ['update_selection', 'select_project', 'select_mode', 'undo', 'redo']) Blockbench.on(event, () => { if (mirrors().size || bar) { hookRender(); updateBar(); } });

Object.assign(window, {DEWMirror: {MIRROR, getMirror, setMirror, discardMirror, copyMirror, combineMirror, targets, syncPreviews}});
