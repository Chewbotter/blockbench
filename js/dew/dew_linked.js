// Select Linked (L) and Separate Loose Parts (Alt + L), as in Blender. A loose part is a set of faces joined through
// shared vertex keys: a slat resting on a base with vertices of its own is a separate part even where the positions
// touch, and one welded to the base is not. Parts are found with a union-find over vertex keys, linear in the mesh.
//
// Select Linked adds the part under the cursor to the face selection (the mesh is selected first if it was not,
// and object mode switches to face mode so the gizmo moves just that part). With the cursor over nothing, every part
// that already holds a selected face is completed instead, so click a face then L works too. The stock Cluster
// selection mode does the same on click, recursively over all faces per face.
//
// Separate Loose Parts splits every selected mesh into one mesh per part. The largest part stays in the original
// element (name, uuid, place in the outliner); the others become copies named `<name>_2`, `<name>_3` and so on,
// placed after it, same origin, rotation and textures.

let last_pointer = null;
document.addEventListener('mousemove', event => { last_pointer = event; }, {passive: true});

// Part id per face key: faces sharing any vertex key end up in the same part
export function looseParts(mesh) {
	let parent = {};
	const find = k => {
		while (parent[k] !== k) {
			parent[k] = parent[parent[k]];
			k = parent[k];
		}
		return k;
	};
	for (let vkey in mesh.vertices) parent[vkey] = vkey;
	for (let fkey in mesh.faces) {
		let vkeys = mesh.faces[fkey].vertices.filter(vkey => parent[vkey] !== undefined);
		for (let i = 1; i < vkeys.length; i++) {
			let a = find(vkeys[0]), b = find(vkeys[i]);
			if (a !== b) parent[b] = a;
		}
	}
	let parts = new Map();
	for (let fkey in mesh.faces) {
		let vkey = mesh.faces[fkey].vertices.find(vkey => parent[vkey] !== undefined);
		let root = vkey === undefined ? 'face:' + fkey : find(vkey);
		if (!parts.has(root)) parts.set(root, []);
		parts.get(root).push(fkey);
	}
	return [...parts.values()];
}

// The mesh and a face key under the pointer, or null
function hoveredFace() {
	if (!last_pointer) return null;
	let preview = Preview.all.find(p => p.canvas === last_pointer.target);
	if (!preview) return null;
	let data = preview.raycast(last_pointer);
	if (!data || !(data.element instanceof Mesh)) return null;
	let mesh = data.element;
	if (data.type == 'element' && data.face && mesh.faces[data.face]) return {mesh, fkey: data.face};
	let vkeys = data.type == 'vertex' ? [data.vertex] : (data.vertices || []);
	for (let fkey in mesh.faces) {
		if (mesh.faces[fkey].vertices.some(vkey => vkeys.includes(vkey))) return {mesh, fkey};
	}
	return null;
}

function selectFaces(mesh, fkeys) {
	let selected_faces = mesh.getSelectedFaces(true);
	let selected_vertices = mesh.getSelectedVertices(true);
	let faces = new Set(selected_faces), vertices = new Set(selected_vertices);
	for (let fkey of fkeys) {
		if (!faces.has(fkey)) { faces.add(fkey); selected_faces.push(fkey); }
		for (let vkey of mesh.faces[fkey].vertices) {
			if (!vertices.has(vkey)) { vertices.add(vkey); selected_vertices.push(vkey); }
		}
	}
}

export function selectLinked() {
	let hovered = hoveredFace();
	let targets = [];
	if (hovered) {
		targets.push(hovered);
	} else {
		for (let mesh of Mesh.selected) {
			for (let fkey of mesh.getSelectedFaces()) targets.push({mesh, fkey});
		}
	}
	if (!targets.length) {
		Blockbench.showQuickMessage('Select Linked: hover a mesh or select a face first');
		return 0;
	}
	Undo.initSelection();
	if (hovered && !hovered.mesh.selected) hovered.mesh.select();
	if (BarItems.selection_mode && BarItems.selection_mode.value == 'object') {
		BarItems.selection_mode.set('face');
		BarItems.selection_mode.onChange(BarItems.selection_mode);
	}
	let count = 0;
	let by_mesh = new Map();
	for (let {mesh, fkey} of targets) {
		if (!by_mesh.has(mesh)) by_mesh.set(mesh, new Set());
		by_mesh.get(mesh).add(fkey);
	}
	for (let [mesh, seeds] of by_mesh) {
		for (let part of looseParts(mesh)) {
			if (!part.some(fkey => seeds.has(fkey))) continue;
			selectFaces(mesh, part);
			count += part.length;
		}
	}
	updateSelection();
	Undo.finishSelection('Select linked');
	return count;
}

export function separateLooseParts(meshes = Mesh.selected.slice()) {
	let elements = meshes.slice();
	Undo.initEdit({elements});
	let created = [];
	for (let mesh of meshes) {
		let parts = looseParts(mesh).sort((a, b) => b.length - a.length);
		if (parts.length < 2) continue;
		let anchor = mesh;
		parts.slice(1).forEach((part, i) => {
			let keep = new Set(part);
			let copy = new Mesh(mesh);
			for (let fkey in copy.faces) if (!keep.has(fkey)) delete copy.faces[fkey];
			for (let fkey of part) delete mesh.faces[fkey];
			let used = new Set();
			for (let fkey in copy.faces) copy.faces[fkey].vertices.forEach(vkey => used.add(vkey));
			for (let vkey in copy.vertices) if (!used.has(vkey)) delete copy.vertices[vkey];
			copy.name = `${mesh.name}_${i + 2}`;
			copy.sortInBefore(anchor, 1).init();
			anchor = copy;
			elements.push(copy);
			created.push(copy);
		});
		let used = new Set();
		for (let fkey in mesh.faces) mesh.faces[fkey].vertices.forEach(vkey => used.add(vkey));
		for (let vkey in mesh.vertices) if (!used.has(vkey)) delete mesh.vertices[vkey];
		delete Project.mesh_selection[mesh.uuid];
	}
	if (created.length) {
		Canvas.updateView({elements, element_aspects: {geometry: true, uv: true, faces: true}, selection: true});
	}
	Undo.finishEdit('Separate loose parts');
	if (created.length) {
		elements[0].select();
		elements.slice(1).forEach(element => element.markAsSelected());
		updateSelection();
	}
	Blockbench.showQuickMessage(created.length ? `Separated into ${elements.length} objects` : 'Separate Loose Parts: no mesh has more than one part');
	return created.length;
}

BARS.defineActions(function() {
	new Action('dew_select_linked', {
		name: 'Select Linked',
		description: 'Add the connected part under the cursor to the face selection, or complete the parts of the selected faces',
		icon: 'link',
		category: 'edit',
		keybind: new Keybind({key: 'l'}),
		condition: {modes: ['edit'], features: ['meshes']},
		click() {
			selectLinked();
		}
	});
	new Action('dew_separate_loose_parts', {
		name: 'Separate Loose Parts',
		description: 'Split each selected mesh into one object per connected part',
		icon: 'call_split',
		category: 'edit',
		keybind: new Keybind({key: 'l', alt: true}),
		condition: {modes: ['edit'], features: ['meshes'], method: () => Mesh.selected.length > 0},
		click() {
			separateLooseParts();
		}
	});
});

Object.assign(window, {DEWLinked: {looseParts, selectLinked, separateLooseParts}});
