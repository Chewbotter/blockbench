/**
 * Extrudes the selected vertices, edges or faces of a mesh: new vertices are created `extend`
 * units along the extrusion direction and connected to the originals with new faces. The mesh
 * selection moves to the new vertices and edges. Extracted from the Extrude action so that
 * Shift+drag on the move gizmo can extrude by zero and pull the new edge in real time.
 */
export function extrudeMeshSelection(mesh: Mesh, extend: number = 1, direction_mode?: string, even_extend?: boolean) {
	let original_vertices = mesh.getSelectedVertices().slice();
	let selected_edges = mesh.getSelectedEdges(true);
	let selected_face_keys = mesh.getSelectedFaces();
	let new_vertices;
	let new_face_keys = [];
	if (original_vertices.length && (Mesh.isVertexSelectionMode() || BarItems.selection_mode.value == 'edge')) {
		selected_face_keys.empty();
	}
	let selected_faces = selected_face_keys.map(fkey => mesh.faces[fkey]);
	let combined_direction;

	selected_faces.forEach(face => {
		original_vertices.safePush(...face.vertices);
	})
	selected_edges.forEach(edge => {
		original_vertices.safePush(...edge);
	})

	if (original_vertices.length >= 3 && !selected_faces.length) {
		let [a, b, c] = original_vertices.slice(0, 3).map(vkey => mesh.vertices[vkey].slice());
		let normal = new THREE.Vector3().fromArray(a.V3_subtract(c));
		normal.cross(new THREE.Vector3().fromArray(b.V3_subtract(c))).normalize();

		let face;
		for (let fkey in mesh.faces) {
			let face2 = mesh.faces[fkey];
			let face_selected_vertices = face2.vertices.filter(vkey => original_vertices.includes(vkey));
			if (face_selected_vertices.length >= 2 && face_selected_vertices.length < face2.vertices.length && face2.vertices.length > 2) {
				face = face2;
				break;
			}
		}
		if (face) {
			let selected_corner = mesh.vertices[face.vertices.find(vkey => original_vertices.includes(vkey))];
			let opposite_corner = mesh.vertices[face.vertices.find(vkey => !original_vertices.includes(vkey))];
			let face_geo_dir = opposite_corner.slice().V3_subtract(selected_corner);
			if (Reusable.vec1.fromArray(face_geo_dir).angleTo(normal) < 1) {
				normal.negate();
			}
		}

		combined_direction = normal.toArray();
	}
	if (direction_mode == 'average' && selected_faces.length) {
		combined_direction = [0, 0, 0];
		for (let face of selected_faces) {
			let normal = face.getNormal(true);
			combined_direction.V3_add(normal);
		}
		combined_direction.V3_divide(selected_faces.length);
	}

	new_vertices = mesh.addVertices(...original_vertices.map(key => {
		let vector = mesh.vertices[key].slice();
		let direction;
		let count = 0;
		switch (direction_mode) {
			case 'average': direction = combined_direction; break;
			case 'y+': direction = [0, 1, 0]; break;
			case 'y-': direction = [0, -1, 0]; break;
			case 'x+': direction = [1, 0, 0]; break;
			case 'x-': direction = [-1, 0, 0]; break;
			case 'z+': direction = [0, 0, 1]; break;
			case 'z-': direction = [0, 0, -1]; break;
		}
		if (!direction) {
			let directions = [];
			selected_faces.forEach(face => {
				if (face.vertices.includes(key)) {
					count++;
					let face_normal = face.getNormal(true);
					directions.push(face_normal);
					if (!direction) {
						direction = face_normal
					} else {
						direction.V3_add(face_normal);
					}
				}
			})
			if (count > 1) {
				let magnitude = Math.sqrt(direction[0]**2 + direction[1]**2 + direction[2]**2);
				direction.V3_divide(magnitude);
				if (even_extend) {
					let a = new THREE.Vector3().fromArray(directions[0]);
					let b = new THREE.Vector3().fromArray(directions[1]);
					let angle = a.angleTo(b);
					direction.V3_divide(Math.cos(angle));
				}
			}
		}
		if (!direction) {
			let match;
			let match_level = 0;
			let match_count = 0;
			for (let key in mesh.faces) {
				let face = mesh.faces[key]; 
				let matches = face.vertices.filter(vkey => original_vertices.includes(vkey));
				if (match_level < matches.length) {
					match_level = matches.length;
					match_count = 1;
					match = face;
				} else if (match_level === matches.length) {
					match_count++;
				}
				if (match_level == 3) break;
			}
			
			if (match_level < 3 && match_count > 2 && original_vertices.length > 2) {
				// If multiple faces connect to the line, there is no point in choosing one for the normal
				// Instead, construct the normal between the first 2 selected vertices
				direction = combined_direction;

			} else if (match) {
				let difference = new THREE.Vector3();
				let signs_done = [];
				match.vertices.forEach(vkey => {
					let sign = original_vertices.includes(vkey) ? 1 : -1;
					difference.x += mesh.vertices[vkey][0] * sign;
					difference.y += mesh.vertices[vkey][1] * sign;
					difference.z += mesh.vertices[vkey][2] * sign;
					signs_done.push(sign);
				})
				direction = difference.normalize().toArray();

			} else if (match) {
				// perpendicular edge, currently unused
				direction = match.getNormal(true);
			} else {
				direction = [0, 1, 0];
			}
		}

		vector.V3_add(direction.map(v => v * extend));
		return vector;
	}))
	Project.mesh_selection[mesh.uuid].vertices.replace(new_vertices);

	// Move Faces
	selected_faces.forEach(face => {
		face.vertices.forEach((key, index) => {
			face.vertices[index] = new_vertices[original_vertices.indexOf(key)];
			let uv = face.uv[key];
			delete face.uv[key];
			face.uv[face.vertices[index]] = uv;
		})
	})

	// Create extra quads on sides
	let remaining_vertices = new_vertices.slice();
	selected_faces.forEach((face, face_index) => {
		let vertices = face.getSortedVertices();
		vertices.forEach((a, i) => {
			let b = vertices[i+1] || vertices[0];
			if (vertices.length == 2 && i) return; // Only create one quad when extruding line
			if (selected_faces.find(f => f != face && f.vertices.includes(a) && f.vertices.includes(b))) return;

			let new_face = new MeshFace(mesh, mesh.faces[selected_face_keys[face_index]]).extend({
				vertices: [
					b,
					a,
					original_vertices[new_vertices.indexOf(a)],
					original_vertices[new_vertices.indexOf(b)],
				]
			});
			let [face_key] = mesh.addFaces(new_face);
			new_face_keys.push(face_key);
			remaining_vertices.remove(a);
			remaining_vertices.remove(b);
		})

		if (vertices.length == 2) delete mesh.faces[selected_face_keys[face_index]];
	})

	// Create Faces for extruded edges
	let new_faces = [];
	selected_edges.forEach(edge => {
		let face, sorted_vertices;
		for (let fkey in mesh.faces) {
			let face2 = mesh.faces[fkey];
			let vertices = face2.vertices;
			if (vertices.includes(edge[0]) && vertices.includes(edge[1])) {
				face = face2;
				sorted_vertices = vertices;
				break;
			}
		}
		if (sorted_vertices[0] == edge[0] && sorted_vertices[1] != edge[1]) {
			edge.reverse();
		}
		let [a, b] = edge.map(vkey => new_vertices[original_vertices.indexOf(vkey)]);
		let [c, d] = edge;
		let new_face = new MeshFace(mesh, face).extend({
			vertices: [a, b, c, d]
		});
		if (new_face.getAngleTo(face) > 90) {
			new_face.invert();
		}
		let [face_key] = mesh.addFaces(new_face);
		new_face_keys.push(face_key);
		new_faces.push(new_face);
		remaining_vertices.remove(a);
		remaining_vertices.remove(b);
	})

	// Create line between points
	remaining_vertices.forEach(a => {
		let b = original_vertices[new_vertices.indexOf(a)]
		let b_in_face = false;
		mesh.forAllFaces(face => {
			if (face.vertices.includes(b)) b_in_face = true;
		})
		if (selected_faces.find(f => f.vertices.includes(a)) && !b_in_face) {
			// Remove line if in the middle of other faces
			delete mesh.vertices[b];
		} else {
			let new_face = new MeshFace(mesh, {
				vertices: [b, a]
			});
			mesh.addFaces(new_face);
		}
	})

	// Update edge selection
	selected_edges.forEach(edge => {
		edge.forEach((vkey, i) => {
			edge[i] = new_vertices[original_vertices.indexOf(vkey)];
		});
	})

	UVEditor.setAutoSize(null, true, new_face_keys);
	return new_face_keys as string[];
}
