// Rig import and pose export, the character track of Distant Early Warning.
//
// Import glTF with Rig (File > Import, and File > Open on a .gltf or .glb) builds one Armature from the file:
// every node becomes an ArmatureBone in the file's own hierarchy, joints, control nodes and rigid pieces
// alike, so a helmet hung on a head node can be posed and animated like a joint; every mesh primitive
// becomes a Mesh element under the Armature with its vertices in the rest pose, skinned by the file's
// weights or, for a rigid piece, welded to its node's bone with weight 1. Blockbench derives the bind from
// the bones' rest pose, so a file that was exported at rest reads back as it was. Flat colour materials
// have no home in Blockbench, so they are baked into one palette texture, one cell each. Animations come
// in as keyframes on the bones, rotations as the difference to the rest rotation, which is how the
// armature animator applies them.
//
// Export Poses writes every animation of the project as one pose, the bones' local rotations relative to
// rest at the animation's first keyframe, keyed by bone name, so a pose transfers to any body with the same
// skeleton and the game applies it through its own pose API without reloading the mesh.
import { THREE } from "../lib/libs";
import { fs, PathModule } from "../native_apis";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export const RIG = {
	SCALE: () => Settings.get('model_export_scale') || 16,	// file units to Blockbench units; the glTF exporter divides by the same setting
	WELD_DISTANCE: 0.01,	// Blockbench units; vertices closer than this become one, which undoes an exporter's splitting
	PALETTE_CELL: 8,		// pixels per flat colour swatch in the palette texture
	PALETTE_COLUMNS: 8,
	BONE_LENGTH: 4,		// drawn length of a bone without connected children
	BONE_WIDTH: 1,
	SCALE_TOLERANCE: 0.001,	// a node scale further than this from 1 is reported, since bones cannot carry one
	POSE_EPSILON: 0.01,	// degrees or units under which a bone counts as unmoved in a pose
	POSE_EULER_ORDER: 'XYZ',	// the readable angles in a pose file; the quaternion beside them is exact
	POSE_FORMAT: 1,
	DECIMALS: 4,
	MESSAGE_TIME: 5000,
};

const round = v => Math.round(v * 10 ** RIG.DECIMALS) / 10 ** RIG.DECIMALS;
const toSRGB8 = c => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
const mimeFor = file => { let ext = file.split('.').pop().toLowerCase(); return ext == 'jpg' || ext == 'jpeg' ? 'image/jpeg' : ext == 'webp' ? 'image/webp' : 'image/png'; };
const toDataURI = (bytes, mime) => `data:${mime};base64,` + Buffer.from(bytes).toString('base64');
const nodeName = obj => obj.userData?.name || obj.name || 'node';

// A .glb is handed to the loader as it is. A .gltf may point at buffers and images beside it, and those are
// inlined first, so the loader never has to fetch a file path from inside the renderer.
function readModelFile(path) {
	if (path.toLowerCase().endsWith('.glb')) {
		let buffer = fs.readFileSync(path);
		return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
	}
	let dir = PathModule.dirname(path);
	let json = JSON.parse(fs.readFileSync(path, 'utf8'));
	for (let list of [json.buffers || [], json.images || []]) {
		for (let item of list) {
			if (!item.uri || item.uri.startsWith('data:')) continue;
			let file = PathModule.join(dir, decodeURIComponent(item.uri));
			item.uri = toDataURI(fs.readFileSync(file), list === json.buffers ? 'application/octet-stream' : mimeFor(file));
		}
	}
	return JSON.stringify(json);
}
const loadGLTF = data => new Promise((resolve, reject) => new GLTFLoader().parse(data, '', resolve, reject));
const imageSize = uri => new Promise(resolve => {
	let img = new Image();
	img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
	img.onerror = () => resolve([16, 16]);
	img.src = uri;
});

export async function importRig(path, options = {}) {
	let scale = options.scale ?? RIG.SCALE();
	let gltf = await loadGLTF(readModelFile(path));
	let json = gltf.parser.json;
	gltf.scene.updateMatrixWorld(true);
	let order = Format.euler_order || 'ZYX';
	let report = {bones: 0, meshes: 0, skinned: 0, faces: 0, vertices: 0, welded: 0, degenerate: 0, textures: 0, palette: 0, animations: 0, keyframes: 0, scaled_nodes: [], untargeted_tracks: 0};

	let objects = [];	// every object under the scene root, parents before children
	gltf.scene.traverse(obj => { if (obj !== gltf.scene) objects.push(obj); });
	// A file that is nothing but meshes at the root (an exported prop) needs no armature
	let use_armature = objects.some(obj => obj.isSkinnedMesh || !obj.isMesh || obj.parent !== gltf.scene);

	Undo.initEdit({outliner: true, elements: [], textures: [], animations: []});
	let added = [], textures_added = [], animations_added = [];

	let armature = null;
	if (use_armature) {
		let roots = gltf.scene.children;
		armature = new Armature({name: roots.length == 1 ? nodeName(roots[0]) : pathToName(path, false)});
		armature.isOpen = true;
		armature.init();
		added.push(armature);
	}

	// Bones: local transform relative to the nearest ancestor that became a bone, which is the parent node
	// except under a skinned mesh node (its own transform plays no part in the skin, so it gets no bone)
	let bone_of = new Map(), bone_by_track = new Map();
	let euler = new THREE.Euler(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), m = new THREE.Matrix4();
	function nearestBone(obj) {
		for (let o = obj.parent; o && o !== gltf.scene; o = o.parent) if (bone_of.has(o)) return bone_of.get(o);
		return null;
	}
	function makeBone(obj) {
		let parent_bone = nearestBone(obj);
		if (parent_bone) m.copy(parent_bone.three.matrixWorld).invert().multiply(obj.matrixWorld);
		else m.copy(obj.matrixWorld);
		m.decompose(p, q, s);
		if ([s.x, s.y, s.z].some(c => Math.abs(c - 1) > RIG.SCALE_TOLERANCE)) report.scaled_nodes.push(nodeName(obj));
		euler.setFromQuaternion(q, order);
		let bone = new ArmatureBone({
			name: nodeName(obj),
			origin: p.toArray().map(c => round(c * scale)),
			rotation: [euler.x, euler.y, euler.z].map(r => round(Math.radToDeg(r))),
			length: RIG.BONE_LENGTH,
			width: RIG.BONE_WIDTH,
		});
		bone.three = obj;
		bone.addTo(parent_bone || armature);
		bone.init();
		bone_of.set(obj, bone);
		bone_by_track.set(obj.name, bone);
		bone_by_track.set(obj.uuid, bone);
		added.push(bone);
		report.bones++;
	}
	if (armature) for (let obj of objects) if (!obj.isSkinnedMesh) makeBone(obj);

	// Textures: one Blockbench texture per image the materials use, and one palette for the flat colours
	let materials = new Map();	// glTF material index -> {texture} or {cell}
	let palette = [];
	async function resolveMaterial(mat) {
		let index = gltf.parser.associations.get(mat)?.index ?? -1;
		if (materials.has(index)) return;
		let def = json.materials?.[index];
		let tex_index = def?.pbrMetallicRoughness?.baseColorTexture?.index;
		if (tex_index != null) {
			let image = json.images[json.textures[tex_index].source];
			let uri = image.uri;
			if (!uri && image.bufferView != null) {
				let bytes = await gltf.parser.getDependency('bufferView', image.bufferView);
				uri = toDataURI(new Uint8Array(bytes), image.mimeType || 'image/png');
			}
			let size = await imageSize(uri);
			let texture = new Texture({name: image.name || def.name || `texture_${tex_index}`}).fromDataURL(uri);
			texture.uv_width = size[0];
			texture.uv_height = size[1];
			texture.add(false);
			textures_added.push(texture);
			materials.set(index, {texture});
			report.textures++;
		} else {
			let color = def?.pbrMetallicRoughness?.baseColorFactor || [1, 1, 1, 1];
			palette.push({name: def?.name || 'material', color});
			materials.set(index, {cell: palette.length - 1});
		}
	}
	let mesh_objects = objects.filter(obj => obj.isMesh);
	for (let obj of mesh_objects) for (let mat of [].concat(obj.material)) await resolveMaterial(mat);
	let palette_texture = null;
	if (palette.length) {
		let c = RIG.PALETTE_CELL, cols = Math.min(palette.length, RIG.PALETTE_COLUMNS), rows = Math.ceil(palette.length / cols);
		let canvas = document.createElement('canvas');
		canvas.width = cols * c;
		canvas.height = rows * c;
		let ctx = canvas.getContext('2d');
		palette.forEach((entry, i) => {
			let [r, g, b] = entry.color.map(toSRGB8);
			let x = (i % cols) * c, y = Math.floor(i / cols) * c;
			ctx.fillStyle = `rgb(${r},${g},${b})`;
			ctx.fillRect(x, y, c, c);
			entry.rect = [x + 1, y + 1, x + c - 1, y + c - 1];	// a pixel in from the cell's edges
		});
		palette_texture = new Texture({name: 'palette'}).fromDataURL(canvas.toDataURL('image/png'));
		palette_texture.uv_width = canvas.width;
		palette_texture.uv_height = canvas.height;
		palette_texture.add(false);
		textures_added.push(palette_texture);
		report.palette = palette.length;
	}

	// Meshes: vertices in the scene's rest pose, relative to the node's position, welded by position
	let v = new THREE.Vector3(), origin = new THREE.Vector3();
	function makeMesh(obj) {
		let entry = materials.get(gltf.parser.associations.get(obj.material)?.index ?? -1);
		let texture = entry?.texture || (entry?.cell != null ? palette_texture : null);
		let cell = entry?.cell != null ? palette[entry.cell].rect : null;
		let geometry = obj.geometry;
		let position = geometry.attributes.position, uv_attr = geometry.attributes.uv;
		let skin_index = geometry.attributes.skinIndex, skin_weight = geometry.attributes.skinWeight;
		let weight_scale = skin_weight?.normalized ? (skin_weight.array instanceof Uint8Array ? 255 : 65535) : 1;
		obj.getWorldPosition(origin).multiplyScalar(scale);
		let element = new Mesh({name: nodeName(obj), origin: origin.toArray().map(round), rotation: [0, 0, 0], vertices: {}});
		let keys = [], key_by_position = new Map(), weights = new Map();
		for (let i = 0; i < position.count; i++) {
			if (obj.isSkinnedMesh) obj.boneTransform(i, v).applyMatrix4(obj.matrixWorld);
			else v.fromBufferAttribute(position, i).applyMatrix4(obj.matrixWorld);
			v.multiplyScalar(scale).sub(origin);
			let position_key = [v.x, v.y, v.z].map(c => Math.round(c / RIG.WELD_DISTANCE)).join(',');
			let vkey = key_by_position.get(position_key);
			if (vkey) { report.welded++; }
			else {
				vkey = element.addVertices([round(v.x), round(v.y), round(v.z)])[0];
				key_by_position.set(position_key, vkey);
				if (obj.isSkinnedMesh) {
					let list = [];
					for (let k = 0; k < 4; k++) {
						let w = skin_weight.array[i * skin_weight.itemSize + k] / weight_scale;
						let bone = w > 0 && bone_of.get(obj.skeleton.bones[skin_index.array[i * skin_index.itemSize + k]]);
						if (bone) list.push([bone, w]);
					}
					weights.set(vkey, list);
				}
			}
			keys.push(vkey);
		}
		let index = geometry.index;
		let count = index ? index.count : position.count;
		let at = t => index ? index.getX(t) : t;
		let uv_width = texture?.uv_width ?? 16, uv_height = texture?.uv_height ?? 16;
		let faces = [];
		for (let t = 0; t + 2 < count; t += 3) {
			let ids = [at(t), at(t + 1), at(t + 2)];
			let vkeys = ids.map(i => keys[i]);
			if (new Set(vkeys).size < 3) { report.degenerate++; continue; }
			let uv = {};
			ids.forEach((i, k) => {
				if (cell) uv[vkeys[k]] = [[cell[0], cell[1]], [cell[2], cell[1]], [cell[0], cell[3]]][k];
				else if (uv_attr) uv[vkeys[k]] = [round(uv_attr.getX(i) * uv_width), round(uv_attr.getY(i) * uv_height)];
				else uv[vkeys[k]] = [0, 0];
			});
			faces.push(new MeshFace(element, {vertices: vkeys, uv, texture: texture || false}));
		}
		for (let i = 0; i < faces.length; i += 4096) element.addFaces(...faces.slice(i, i + 4096));
		element.addTo(armature || 'root');
		element.init();
		added.push(element);
		if (obj.isSkinnedMesh) {
			for (let [vkey, list] of weights) for (let [bone, w] of list) bone.setVertexWeight(element, vkey, round(w));
			report.skinned++;
		} else if (bone_of.has(obj)) {
			for (let vkey of key_by_position.values()) bone_of.get(obj).setVertexWeight(element, vkey, 1);
		}
		report.meshes++;
		report.faces += faces.length;
		report.vertices += key_by_position.size;
	}
	for (let obj of mesh_objects) makeMesh(obj);

	// Animations: a track targets a node by three's sanitized name (or uuid); values become keyframes relative
	// to the bone's rest, rotations as euler differences in the format's order, unwrapped so consecutive keys
	// never take the long way round
	function importClip(clip) {
		let animation = new Animation({name: clip.name || 'animation', length: round(clip.duration), loop: 'loop', snapping: 24});
		animation.add(false);
		let keyframes = 0;
		for (let track of clip.tracks) {
			let dot = track.name.lastIndexOf('.');
			let bone = bone_by_track.get(track.name.slice(0, dot));
			let property = track.name.slice(dot + 1);
			let channel = property == 'quaternion' ? 'rotation' : property == 'position' ? 'position' : property == 'scale' ? 'scale' : null;
			if (!bone || !channel) { report.untargeted_tracks++; continue; }
			let animator = animation.getBoneAnimator(bone);
			let size = track.getValueSize();
			let previous = null;
			for (let k = 0; k < track.times.length; k++) {
				let values = Array.from(track.values.slice(k * size, (k + 1) * size));
				let data;
				if (channel == 'rotation') {
					euler.setFromQuaternion(q.fromArray(values), order);
					data = [euler.x, euler.y, euler.z].map((r, i) => Math.radToDeg(r) - bone.rotation[i]);
					if (previous) data = data.map((d, i) => d + 360 * Math.round((previous[i] - d) / 360));
					previous = data;
				} else if (channel == 'position') {
					data = values.map((c, i) => c * scale - bone.origin[i]);
				} else {
					data = values;
				}
				animator.addKeyframe({channel, time: round(track.times[k]), interpolation: 'linear', data_points: [{x: round(data[0]), y: round(data[1]), z: round(data[2])}]});
				keyframes++;
			}
		}
		if (!keyframes) { animation.remove(false); return; }
		animations_added.push(animation);
		report.animations++;
		report.keyframes += keyframes;
	}
	for (let clip of gltf.animations || []) importClip(clip);

	for (let bone of bone_of.values()) delete bone.three;
	Undo.finishEdit('Import glTF with rig', {outliner: true, elements: added, textures: textures_added, animations: animations_added});
	Canvas.updateAll();
	updateSelection();
	let notes = [];
	if (report.scaled_nodes.length) notes.push(`${report.scaled_nodes.length} scaled nodes (${report.scaled_nodes.slice(0, 3).join(', ')}${report.scaled_nodes.length > 3 ? ', ...' : ''}): bones carry no scale, so their children sit where the file put them but the scale itself is lost`);
	if (report.untargeted_tracks) notes.push(`${report.untargeted_tracks} animation tracks found no bone`);
	Blockbench.showQuickMessage(`Imported ${report.meshes} meshes (${report.skinned} skinned, ${report.faces} faces), ${report.bones} bones, ${report.textures} textures${report.palette ? `, ${report.palette} flat colours in a palette` : ''}${report.animations ? `, ${report.animations} animations` : ''}${notes.length ? '. ' + notes.join('. ') : ''}`, RIG.MESSAGE_TIME);
	return report;
}

// Poses: the difference between each bone's rest and where the animation puts it at its first keyframe
export function samplePose(animation) {
	let times = [];
	for (let id in animation.animators) {
		let animator = animation.animators[id];
		for (let channel of ['rotation', 'position', 'scale']) animator[channel]?.forEach(kf => times.push(kf.time));
	}
	let time = times.length ? Math.min(...times) : 0;
	let was_time = Timeline.time;
	Animator.showDefaultPose(true);
	Timeline.time = time;
	Animator.stackAnimations([animation], false);
	let pose = {};
	let rest = new THREE.Quaternion(), relative = new THREE.Quaternion(), delta = new THREE.Vector3(), e = new THREE.Euler();
	for (let bone of ArmatureBone.all) {
		let o = bone.scene_object;
		rest.setFromEuler(o.fix_rotation);
		relative.copy(rest).invert().multiply(o.quaternion);
		let angle = Math.radToDeg(2 * Math.acos(Math.min(1, Math.abs(relative.w))));
		delta.copy(o.position).sub(o.fix_position);
		if (angle < RIG.POSE_EPSILON && delta.length() < RIG.POSE_EPSILON) continue;
		e.setFromQuaternion(relative, RIG.POSE_EULER_ORDER);
		let entry = {q: relative.toArray().map(round), deg: [e.x, e.y, e.z].map(r => round(Math.radToDeg(r)))};
		if (delta.length() >= RIG.POSE_EPSILON) entry.pos = delta.toArray().map(round);
		pose[bone.name] = entry;
	}
	Timeline.time = was_time;
	Animator.showDefaultPose(true);
	if (Animator.open) Animator.preview();
	return {time, pose};
}
export function compilePoses() {
	let poses = {};
	for (let animation of Animator.animations) poses[animation.name] = samplePose(animation).pose;
	return {
		format: 'dew_poses',
		version: RIG.POSE_FORMAT,
		model: Project.name || '',
		units: 'Blockbench units (1 = 1 texel) and degrees',
		convention: `per bone, in the bone's own frame, relative to its rest: q is the rotation quaternion [x, y, z, w] and is exact; deg is the same rotation as ${RIG.POSE_EULER_ORDER} euler degrees, for reading; pos is the translation from rest, present only where a bone moved`,
		poses,
	};
}

let codec = new Codec('dew_gltf', {
	name: 'glTF with Rig',
	extension: 'gltf',
	remember: false,
	format: 'free',
	load_filter: {type: 'text', extensions: ['gltf', 'glb']},
	parse(model, path) {
		importRig(path).catch(err => {
			console.error(err);
			Blockbench.showMessageBox({title: 'glTF import failed', message: String(err?.message || err), icon: 'error'});
		});
	},
});

BARS.defineActions(function() {
	new Action('dew_import_rig', {
		name: 'Import glTF with Rig...',
		description: 'Import a .gltf or .glb with its skeleton and weights as an Armature, every node a bone, flat colours baked into a palette texture',
		icon: 'accessibility',
		category: 'file',
		condition: () => Project && Format.armature_rig,
		click() {
			Blockbench.import({
				resource_id: 'model',
				extensions: ['gltf', 'glb'],
				type: 'glTF Model',
				readtype: 'none',
			}, files => {
				if (files[0]?.path) importRig(files[0].path).catch(err => {
					console.error(err);
					Blockbench.showMessageBox({title: 'glTF import failed', message: String(err?.message || err), icon: 'error'});
				});
			});
		},
	});
	new Action('dew_export_poses', {
		name: 'Export Poses...',
		description: 'Write every animation as a pose: each bone\'s rotation relative to rest at the animation\'s first keyframe, keyed by bone name',
		icon: 'sports_martial_arts',
		category: 'file',
		condition: () => Project && ArmatureBone.all.length && Animator.animations.length,
		click() {
			let content = JSON.stringify(compilePoses(), null, '\t');
			Blockbench.export({
				resource_id: 'dew_poses',
				type: 'DEW Poses',
				extensions: ['json'],
				name: `${Project.name || 'model'}.poses`,
				startpath: Project.export_path,
				content,
			});
		},
	});
});

Object.assign(window, {DEWRig: {RIG, importRig, samplePose, compilePoses, codec}});
