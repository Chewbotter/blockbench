import { THREE } from './../../lib/libs';
import { fillAllRims } from './fill_rim';

export function cleanupOverlappingMeshFaces(mesh: Mesh) {
	for (let fkey in mesh.faces) {
		let face = mesh.faces[fkey];
		if (face.vertices.length < 2) {
			delete mesh.faces[fkey];
		} else {
			for (let fkey2 in mesh.faces) {
				let face2 = mesh.faces[fkey2];
				if (fkey == fkey2 || !face2) continue;
				let overlaps = face.vertices.allAre(vkey => face2.vertices.includes(vkey));
				if (overlaps) {
					delete mesh.faces[fkey];
				}
			}
		}
	}
}

BARS.defineActions(() => {
	function mergeVertices(by_distance: boolean, in_center: boolean) {
		let found = 0, result = 0;
		Undo.initEdit({elements: Mesh.selected});
		Mesh.selected.forEach(mesh => {
			let selected_vertices = mesh.getSelectedVertices();
			if (selected_vertices.length < 2) return;

			if (!by_distance) {
				let first_vertex = selected_vertices[0];
				if (in_center) {
					let center: ArrayVector3 = [0, 0, 0];
					selected_vertices.forEach(vkey => {
						center.V3_add(mesh.vertices[vkey]);
					})
					center.V3_divide(selected_vertices.length);
					mesh.vertices[first_vertex].V3_set(center);

					for (let fkey in mesh.faces) {
						let face = mesh.faces[fkey];
						let matches = selected_vertices.filter(vkey => face.vertices.includes(vkey));
						if (matches.length < 2) continue;
						let center = [0, 0];
						matches.forEach(vkey => {
							center[0] += face.uv[vkey][0];
							center[1] += face.uv[vkey][1];
						})
						center[0] /= matches.length;
						center[1] /= matches.length;
						matches.forEach(vkey => {
							face.uv[vkey][0] = center[0];
							face.uv[vkey][1] = center[1];
						})
					}
				}
				selected_vertices.forEach(vkey => {
					if (vkey == first_vertex) return;
					for (let fkey in mesh.faces) {
						let face = mesh.faces[fkey];
						let index = face.vertices.indexOf(vkey);
						if (index === -1) continue;

						if (face.vertices.includes(first_vertex)) {
							face.vertices.remove(vkey);
							delete face.uv[vkey];
							if (face.vertices.length < 2) {
								delete mesh.faces[fkey];
							}
						} else {
							let uv = face.uv[vkey];
							face.vertices.splice(index, 1, first_vertex);
							face.uv[first_vertex] = uv;
							delete face.uv[vkey];
						}
					}
					delete mesh.vertices[vkey];
				})
				selected_vertices.splice(1, selected_vertices.length);
				
			} else {

				let selected_vertices = mesh.getSelectedVertices().slice();
				if (selected_vertices.length < 2) return;
				let groups = {};
				let i = 0;
				while (selected_vertices[i]) {
					let vkey1 = selected_vertices[i];
					let j = i+1;
					while (selected_vertices[j]) {
						let vkey2 = selected_vertices[j];
						let vector1 = mesh.vertices[vkey1];
						let vector2 = mesh.vertices[vkey2];
						let dist = Math.sqrt(Math.pow(vector2[0] - vector1[0], 2) + Math.pow(vector2[1] - vector1[1], 2) + Math.pow(vector2[2] - vector1[2], 2));
						if (dist < (settings.vertex_merge_distance.value as number)) {
							if (!groups[vkey1]) groups[vkey1] = [];
							groups[vkey1].push(vkey2);
						}
						j++;
					}
					if (groups[vkey1]) {
						groups[vkey1].forEach(vkey2 => {
							selected_vertices.remove(vkey2);
						})
					}
					i++;
				}

				let current_selected_vertices = mesh.getSelectedVertices();
				for (let first_vertex in groups) {
					let group = groups[first_vertex];
					if (in_center) {
						let group_all = [first_vertex, ...group];
						let center: ArrayVector3 = [0, 0, 0];
						group_all.forEach(vkey => {
							center.V3_add(mesh.vertices[vkey]);
						})
						center.V3_divide(group_all.length);
						mesh.vertices[first_vertex].V3_set(center);

						for (let fkey in mesh.faces) {
							let face = mesh.faces[fkey];
							let matches = group_all.filter(vkey => face.vertices.includes(vkey));
							if (matches.length < 2) continue;
							let center = [0, 0];
							matches.forEach(vkey => {
								center[0] += face.uv[vkey][0];
								center[1] += face.uv[vkey][1];
							})
							center[0] /= matches.length;
							center[1] /= matches.length;
							matches.forEach(vkey => {
								face.uv[vkey][0] = center[0];
								face.uv[vkey][1] = center[1];
							})
						}
					}
					group.forEach(vkey => {
						for (let fkey in mesh.faces) {
							let face = mesh.faces[fkey];
							let index = face.vertices.indexOf(vkey);
							if (index === -1) continue;

							if (face.vertices.includes(first_vertex)) {
								face.vertices.remove(vkey);
								delete face.uv[vkey];
								if (face.vertices.length < 2) {
									delete mesh.faces[fkey];
								}
							} else {
								let uv = face.uv[vkey];
								face.vertices.splice(index, 1, first_vertex);
								face.uv[first_vertex] = uv;
								delete face.uv[vkey];
							}
						}
						found++;
						delete mesh.vertices[vkey];
						current_selected_vertices.remove(vkey);
					})
					found++;
					result++;
				}
			}
			cleanupOverlappingMeshFaces(mesh);
		})
		Undo.finishEdit('Merge vertices')
		Canvas.updateView({elements: Mesh.selected, element_aspects: {geometry: true, uv: true, faces: true}, selection: true})
		if (by_distance) {
			Blockbench.showQuickMessage(tl('message.merged_vertices', [found, result]), 2000);
		}
	}
	new Action('merge_vertices', {
		icon: 'close_fullscreen',
		category: 'edit',
		keybind: new Keybind({key: 'm', shift: true}),
		condition: {modes: ['edit'], features: ['meshes'], method: () => (Mesh.selected[0] && Mesh.selected[0].getSelectedVertices().length > 1)},
		click() {
			new Menu(this.children).open('mouse');
		},
		children: [
			{
				id: 'merge_all',
				name: 'action.merge_vertices.merge_all',
				icon: 'north_east',
				click() {mergeVertices(false, false);}
			},
			{
				id: 'merge_all_in_center',
				name: 'action.merge_vertices.merge_all_in_center',
				icon: 'close_fullscreen',
				click() {mergeVertices(false, true);}
			},
			{
				id: 'merge_by_distance',
				name: 'action.merge_vertices.merge_by_distance',
				icon: 'expand_less',
				click() {mergeVertices(true, false);}
			},
			{
				id: 'merge_by_distance_in_center',
				name: 'action.merge_vertices.merge_by_distance_in_center',
				icon: 'unfold_less',
				click() {mergeVertices(true, true);}
			}
		]
	})
	new Action('merge_meshes', {
		icon: 'upload',
		category: 'edit',
		condition: {modes: ['edit'], features: ['meshes'], method: () => (Mesh.selected.length >= 2)},
		click() {
			let elements = Mesh.selected.slice();
			Undo.initEdit({elements, outliner: true});
			let original = Mesh.selected[0];
			let vector = new THREE.Vector3();

			Mesh.selected.forEach(mesh => {
				if (mesh == original) return;

				let old_vertex_keys = Object.keys(mesh.vertices);
				let new_vertex_keys = original.addVertices(...mesh.vertice_list.map(arr => {
					vector.fromArray(arr);
					mesh.mesh.localToWorld(vector);
					original.mesh.worldToLocal(vector);
					return vector.toArray()
				}));

				for (let key in mesh.faces) {
					let old_face = mesh.faces[key];
					let new_face = new MeshFace(original, old_face);
					let uv = {};
					for (let vkey in old_face.uv) {
						let new_vkey = new_vertex_keys[old_vertex_keys.indexOf(vkey)]
						uv[new_vkey] = old_face.uv[vkey];
					}
					new_face.extend({
						vertices: old_face.vertices.map(v => new_vertex_keys[old_vertex_keys.indexOf(v)]),
						uv
					})
					original.addFaces(new_face)
				}

				mesh.remove();
				elements.remove(mesh);
				Mesh.selected.remove(mesh)
			})
			updateSelection();
			Undo.finishEdit('Merge meshes')
			Canvas.updateView({elements, element_aspects: {geometry: true, uv: true, faces: true}, selection: true})
		}
	})
	new Action('split_mesh', {
		icon: 'call_split',
		category: 'edit',
		condition: {
			modes: ['edit'],
			features: ['meshes'],
			method: () => !!(Mesh.selected[0] && Mesh.selected[0].getSelectedVertices().length)
		},
		click() {
			let elements = Mesh.selected.slice();
			Undo.initEdit({elements});

			Mesh.selected.forEach(mesh => {
				splitSelectedFaces(mesh, elements);
			})
			Undo.finishEdit('Split mesh');
			updateSelection();
			Canvas.updateView({elements, element_aspects: {geometry: true, uv: true, faces: true}, selection: true})
		}
	})
	new Action('split_closed_mesh', {
		icon: 'content_cut',
		category: 'edit',
		condition: {
			modes: ['edit'],
			features: ['meshes'],
			method: () => !!(Mesh.selected[0] && Mesh.selected[0].getSelectedFaces().length)
		},
		click() {
			let elements = Mesh.selected.slice();
			Undo.initEdit({elements});

			let open_rims_left = 0;
			let caps_by_mesh: {mesh: Mesh, faces: string[]}[] = [];
			Mesh.selected.forEach(mesh => {
				// Vertices shared between selected and unselected faces are where the cut opens both meshes
				let selected_faces = mesh.getSelectedFaces();
				let inside = new Set<string>(), outside = new Set<string>();
				for (let fkey in mesh.faces) {
					let target = selected_faces.includes(fkey) ? inside : outside;
					mesh.faces[fkey].vertices.forEach(vkey => target.add(vkey));
				}
				let cut_vertices = [...inside].filter(vkey => outside.has(vkey));

				let copy = splitSelectedFaces(mesh, elements);

				for (let part of [mesh, copy]) {
					let present = cut_vertices.filter(vkey => part.vertices[vkey]);
					let result = fillAllRims(part, present);
					if (present.length && !result.loops) open_rims_left++;
					caps_by_mesh.push({mesh: part, faces: result.faces});
					part.preview_controller.updateGeometry(part);
				}
			})

			// Auto-UV the caps; setAutoSize works on the selected elements, so select each mesh in turn
			let selection_backup = Outliner.selected.slice();
			for (let {mesh, faces} of caps_by_mesh) {
				if (!faces.length) continue;
				Outliner.selected.replace([mesh]);
				UVEditor.setAutoSize(null, true, faces);
			}
			Outliner.selected.replace(selection_backup);

			Undo.finishEdit('Split closed mesh');
			updateSelection();
			Canvas.updateView({elements, element_aspects: {geometry: true, uv: true, faces: true}, selection: true})
			if (open_rims_left) {
				Blockbench.showQuickMessage('message.split_closed_mesh.open_rim', 2500);
			}
		}
	})

	/**
	 * Moves the selected faces of the mesh into a new mesh, which is added to `elements` and becomes the selected one.
	 * Shared vertices are kept in both meshes.
	 */
	function splitSelectedFaces(mesh: Mesh, elements: OutlinerElement[]): Mesh {
		let selected_vertices = mesh.getSelectedVertices();
		let mesh_selection = Project.mesh_selection[mesh.uuid];

		let copy = new Mesh(mesh);
		elements.push(copy);

		for (let fkey in mesh.faces) {
			let face = mesh.faces[fkey];
			if (face.isSelected(fkey)) {
				delete mesh.faces[fkey];
			} else {
				delete copy.faces[fkey];
			}
		}

		selected_vertices.forEach(vkey => {
			let used = false;
			for (let key in mesh.faces) {
				let face = mesh.faces[key];
				if (face.vertices.includes(vkey)) used = true;
			}
			if (!used) {
				delete mesh.vertices[vkey];
			}
		})
		Object.keys(copy.vertices).filter(vkey => !selected_vertices.includes(vkey)).forEach(vkey => {
			let used = false;
			for (let key in copy.faces) {
				let face = copy.faces[key];
				if (face.vertices.includes(vkey)) used = true;
			}
			if (!used) {
				delete copy.vertices[vkey];
			}
		})

		copy.name += '_selection'
		copy.sortInBefore(mesh, 1).init();
		delete Project.mesh_selection[mesh.uuid];
		Project.mesh_selection[copy.uuid] = mesh_selection;
		mesh.preview_controller.updateGeometry(mesh);
		selected[selected.indexOf(mesh)] = copy;
		return copy;
	}
})

const global = {
	cleanupOverlappingMeshFaces
}
declare global {
	const cleanupOverlappingMeshFaces: typeof global.cleanupOverlappingMeshFaces
}
Object.assign(window, global);
