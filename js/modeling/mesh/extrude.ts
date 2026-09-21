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

	// Pre-compute ALL UVs before modifying any face (faces are still unmodified)
	const vec1 = new THREE.Vector3();
	// Reusable vectors for side quad UV pre-computation
	const _ova = new THREE.Vector3(), _ovb = new THREE.Vector3(), _ovc = new THREE.Vector3();
	const _ouva = new THREE.Vector2(), _ouvb = new THREE.Vector2(), _ouvc = new THREE.Vector2();
	const _fn = new THREE.Vector3(), _ed = new THREE.Vector3(), _ip = new THREE.Vector3();
	const _poa = new THREE.Vector3(), _pob = new THREE.Vector3();
	const _pna = new THREE.Vector3(), _pnb = new THREE.Vector3();
	const _ext = new THREE.Vector3(), _prb = new THREE.Vector3();
	const _tuv = new THREE.Vector2();
	const face_old_uvs = new Map()
	const face_orig_keys = new Map()
	const face_new_uvs = new Map()
	const face_side_data = new Map()  // face -> [{a, b, orig_a, orig_b, uv_a, uv_b}, ...]
	selected_faces.forEach(face => {
		if (face.vertices.length < 3) return;
		// Save original vertex keys
		let orig_keys = [...face.vertices]
		face_orig_keys.set(face, orig_keys)
		let old_uvs = {...face.uv}
		face_old_uvs.set(face, old_uvs)
		// Cap face UVs: project new vertex positions onto old face plane
		const cap_uvs = {}
		for (const vertex_key of face.vertices) {
			const new_vertex_key = new_vertices[original_vertices.indexOf(vertex_key)];
			cap_uvs[new_vertex_key] = face.localToUV(vec1.fromArray(mesh.vertices[new_vertex_key]));
		}
		face_new_uvs.set(face, cap_uvs)
		// Side quad UVs: pre-compute using old face data
		const side_quads = []
		let sorted = face.getSortedVertices();
		if (sorted.length < 2) { face_side_data.set(face, side_quads); return; }
		// Old-face triangle for UV projection
		let tri = [orig_keys[0], orig_keys[1], orig_keys[2]];
		_ova.fromArray(mesh.vertices[tri[0]]);
		_ovb.fromArray(mesh.vertices[tri[1]]);
		_ovc.fromArray(mesh.vertices[tri[2]]);
		_ouva.fromArray(old_uvs[tri[0]]);
		_ouvb.fromArray(old_uvs[tri[1]]);
		_ouvc.fromArray(old_uvs[tri[2]]);
		_fn.crossVectors(_ovb.clone().sub(_ova), _ovc.clone().sub(_ova)).normalize();
		function oldFaceUV(world_pos, target) {
			return THREE.Triangle.getUV(world_pos, _ova, _ovb, _ovc, _ouva, _ouvb, _ouvc, target);
		}
		sorted.forEach((orig_a, i) => {
			let orig_b = sorted[i+1] || sorted[0];
			if (sorted.length == 2 && i) return;
			if (selected_faces.find(f => f != face && f.vertices.includes(orig_a) && f.vertices.includes(orig_b))) return;
			// orig_a/orig_b are old keys (face unmodified); map to new keys
			let a = new_vertices[original_vertices.indexOf(orig_a)]
			let b = new_vertices[original_vertices.indexOf(orig_b)]
			_poa.fromArray(mesh.vertices[orig_a]);
			_pob.fromArray(mesh.vertices[orig_b]);
			_ed.copy(_pob).sub(_poa).normalize();
			_ip.crossVectors(_ed, _fn);
			// Vertex a: decompose ext_vec, rotate normal into face plane
			_pna.fromArray(mesh.vertices[a]);
			_ext.copy(_pna).sub(_poa);
			let n_a = _ext.dot(_fn);
			_prb.copy(_poa)
				.add(_ext).addScaledVector(_fn, -n_a)
				.addScaledVector(_ip, n_a);
			let uv_a = oldFaceUV(_prb, _tuv).toArray();
			// Vertex b
			_pnb.fromArray(mesh.vertices[b]);
			_ext.copy(_pnb).sub(_pob);
			let n_b = _ext.dot(_fn);
			_prb.copy(_pob)
				.add(_ext).addScaledVector(_fn, -n_b)
				.addScaledVector(_ip, n_b);
			let uv_b = oldFaceUV(_prb, _tuv).toArray();
			side_quads.push({a, b, orig_a, orig_b, uv_a, uv_b});
		})
		face_side_data.set(face, side_quads)
	})

	// Now modify faces using pre-computed cap UVs
	selected_faces.forEach(face => {
		if (face.vertices.length < 3) return;
		let cap_uvs = face_new_uvs.get(face)
		face.vertices.forEach((key, index) => {
			const new_vertex_key = new_vertices[original_vertices.indexOf(key)];
			face.vertices[index] = new_vertex_key;
			delete face.uv[key];
			face.uv[new_vertex_key] = cap_uvs[new_vertex_key];
		});
	})

	// Create side quads from pre-computed data
	let remaining_vertices = new_vertices.slice();
	selected_faces.forEach((face, face_index) => {
		if (face.vertices.length < 3) return;
		let old_uvs = face_old_uvs.get(face)
		let side_quads = face_side_data.get(face)
		side_quads.forEach(q => {
			let new_face = new MeshFace(mesh, mesh.faces[selected_face_keys[face_index]]).extend({
				vertices: [q.b, q.a, q.orig_a, q.orig_b],
				uv: {[q.a]: q.uv_a, [q.b]: q.uv_b, [q.orig_a]: old_uvs[q.orig_a], [q.orig_b]: old_uvs[q.orig_b]}
			});
			let [face_key] = mesh.addFaces(new_face);
			new_face_keys.push(face_key);
			remaining_vertices.remove(q.a);
			remaining_vertices.remove(q.b);
		})
		if (face.getSortedVertices().length == 2) delete mesh.faces[selected_face_keys[face_index]];
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
			vertices: [a, b, c, d],
			uv: {
				[a]: face.localToUV(vec1.fromArray(mesh.vertices[a])),
				[b]: face.localToUV(vec1.fromArray(mesh.vertices[b])),
				[c]: face.uv[c],
				[d]: face.uv[d]
			}
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

	return new_face_keys as string[];
}
