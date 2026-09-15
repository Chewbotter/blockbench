// Distant Early Warning fabric: cube elements tagged with a game material and filled from the game's material
// manifest. The contract is BLOCKBENCH_HANDOFF.md sections 3 to 5: the game reads the saved .bbmodel itself, every
// fabric cube carries `game.material`, every group `game.kind`, and every fabric face owns its own region of the
// scene's atlas at 1 texel per unit, because the game paints damage into that region at runtime.
import { DEW } from "./dew_scene";
import { fs, PathModule } from "../native_apis";

export const MATERIAL = {
	GAME_DIR: 'D:/Work/DistantEarlyWarning/distantearly_game',
	MANIFEST: 'textures/materials/materials.json',		// under GAME_DIR; the game writes it on every run
	MODELS_DIR: 'models',								// under GAME_DIR: models/<name>/<Name>.bbmodel
	ATLAS_NAME: 'atlas',								// the scene texture the fills go into
	ATLAS_SIZES: [512, 1024, 2048, 4096],				// the atlas grows through these when a face does not fit
	ALLOC_STEP: 4,										// regions start on this grid, the game's sample size
	GHOST_COLOR: 0xffb347,
	MESSAGE_TIME: 2500,
};

// The tags ride on the elements as one object property, so load, save, copy and undo all carry them
new Property(Cube, 'object', 'game');
new Property(Group, 'object', 'game');

// Empty tag objects are noise in the file: an untagged cube is fabric by the contract's own fallback
Blockbench.on('save_project', ({model}) => {
	let strip = list => list && list.forEach(node => {
		if (node.game && !Object.keys(node.game).length) delete node.game;
		if (node.children) strip(node.children);
	});
	strip(model.elements);
	strip(model.groups);		// format 5.0 keeps groups here; the outliner holds only uuids and children
	strip(model.outliner);
});

// The manifest and its fill tiles, re-read when the file changes on disk
const manifest_state = {data: null, mtime: 0, fills: new Map(), selected: null, loading: null};
function manifestPath() {
	return PathModule.join(MATERIAL.GAME_DIR, MATERIAL.MANIFEST);
}
function readManifest() {
	let path = manifestPath();
	if (!fs.existsSync(path)) return null;
	let mtime = fs.statSync(path).mtimeMs;
	if (manifest_state.data && manifest_state.mtime == mtime) return manifest_state.data;
	try {
		manifest_state.data = JSON.parse(fs.readFileSync(path, 'utf8'));
		manifest_state.mtime = mtime;
		manifest_state.fills.clear();
	} catch (err) {
		console.error('DEW materials: manifest unreadable', err);
		return manifest_state.data;
	}
	return manifest_state.data;
}
export function getMaterials() {
	let manifest = readManifest();
	return manifest && manifest.materials ? manifest.materials : [];
}
export function getMaterial(name) {
	return getMaterials().find(material => material.name == name) || null;
}
export function tagKeys() {
	let manifest = readManifest();
	let tags = (manifest && manifest.tags) || {};
	return {
		material: (tags.element_material || 'game.material').split('.').pop(),
		kind: (tags.group_kind || 'game.kind').split('.').pop(),
		kinds: tags.kinds || ['fabric', 'prop'],
	};
}
export function fillPath(material) {
	return PathModule.join(MATERIAL.GAME_DIR, PathModule.dirname(MATERIAL.MANIFEST), material.fill);
}
// The fill tile as pixel data, loaded once per manifest read
function loadFill(material) {
	if (manifest_state.fills.has(material.name)) return Promise.resolve(manifest_state.fills.get(material.name));
	return new Promise(resolve => {
		let img = new Image();
		img.onload = () => {
			let canvas = document.createElement('canvas');
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			let ctx = canvas.getContext('2d');
			ctx.drawImage(img, 0, 0);
			let fill = {width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data};
			manifest_state.fills.set(material.name, fill);
			resolve(fill);
		};
		img.onerror = () => {
			console.error('DEW materials: fill tile missing', fillPath(material));
			resolve(null);
		};
		img.src = fillPath(material) + '?' + manifest_state.mtime;
	});
}

// The scene's atlas: one internal texture every fabric face maps into. Made on first use, grown when full.
export function getAtlas(create = true) {
	let atlas = Texture.all.find(texture => texture.name == MATERIAL.ATLAS_NAME || texture.name == MATERIAL.ATLAS_NAME + '.png');
	if (atlas || !create) return atlas || null;
	let size = MATERIAL.ATLAS_SIZES[0];
	let canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	atlas = new Texture({name: MATERIAL.ATLAS_NAME}).fromDataURL(canvas.toDataURL()).add(false, true);
	// The image loads asynchronously and the texture's own canvas is sized from it then; a fill painted before
	// that landed on a 16 x 16 canvas and wrote it back as the source. Size everything now.
	atlas.canvas.width = atlas.canvas.height = size;
	atlas.width = atlas.height = atlas.uv_width = atlas.uv_height = size;
	return atlas;
}
function atlasReady(atlas) {
	if (atlas.img.complete && atlas.img.naturalWidth) return Promise.resolve();
	return new Promise(resolve => atlas.img.addEventListener('load', () => resolve(), {once: true}));
}
function growAtlas(atlas) {
	let next = MATERIAL.ATLAS_SIZES.find(size => size > atlas.width);
	if (!next) return false;
	let old = document.createElement('canvas');
	old.width = atlas.canvas.width;
	old.height = atlas.canvas.height;
	old.getContext('2d').drawImage(atlas.canvas, 0, 0);
	atlas.canvas.width = atlas.canvas.height = next;
	atlas.ctx.drawImage(old, 0, 0);
	atlas.width = atlas.height = atlas.uv_width = atlas.uv_height = next;
	atlas.updateChangesAfterEdit();
	return true;
}
// Regions the atlas already hands out: every cube face mapped into it
function usedRegions(atlas) {
	let regions = [];
	for (let cube of Cube.all) {
		for (let key in cube.faces) {
			let face = cube.faces[key];
			if (face.texture != atlas.uuid) continue;
			let [x0, y0, x1, y1] = face.uv;
			regions.push({x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), face});
		}
	}
	return regions;
}
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
// Bottom-left packing: the lowest, then leftmost, corner of an existing region where a w x h rectangle fits.
// Quadratic in the number of regions and fine for a room; a cluster-wide refill is where it would show.
function allocateRegion(regions, w, h, size) {
	let step = MATERIAL.ALLOC_STEP;
	let candidates = [[0, 0]];
	for (let r of regions) candidates.push([r.x + r.w, r.y], [r.x, r.y + r.h]);
	candidates.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
	for (let [x, y] of candidates) {
		x = Math.ceil(x / step) * step;
		y = Math.ceil(y / step) * step;
		if (x + w > size || y + h > size) continue;
		let rect = {x, y, w, h};
		if (!regions.some(r => overlaps(rect, r))) return rect;
	}
	return null;
}
export function atlasUsage() {
	let atlas = getAtlas(false);
	if (!atlas) return {size: 0, used: 0, fraction: 0};
	let used = usedRegions(atlas).reduce((sum, r) => sum + r.w * r.h, 0);
	return {size: atlas.width, used, fraction: used / (atlas.width * atlas.height)};
}

// Face size in texels, 1 per unit, and how the face's texels run through cube space: UVToLocal maps uv to a
// point in the cube's own frame (from/to coordinates, less origin), so the fill is sampled there. Unrotated
// cubes read world position, so a pattern carries on across touching cubes; a rotated slab reads along itself.
function faceTexels(cube, key) {
	let size = [0, 1, 2].map(i => Math.abs(cube.to[i] - cube.from[i]));
	let dims = {north: [0, 1], south: [0, 1], east: [2, 1], west: [2, 1], up: [0, 2], down: [0, 2]}[key];
	return [Math.max(1, Math.ceil(size[dims[0]])), Math.max(1, Math.ceil(size[dims[1]]))];
}
function faceFrame(face) {
	let [u0, v0] = [Math.min(face.uv[0], face.uv[2]), Math.min(face.uv[1], face.uv[3])];
	let origin = new THREE.Vector3().fromArray(face.cube.origin);
	let at = (u, v) => face.UVToLocal([u, v]).add(origin);
	let p = at(u0 + 0.5, v0 + 0.5);
	let dx = at(u0 + 1.5, v0 + 0.5).sub(p.clone());
	let dy = at(u0 + 0.5, v0 + 1.5).sub(p.clone());
	return {p, dx, dy};
}
// Pixels the fill gives a face: the tile repeated by cube-space position, so brick courses line up
function fillPixels(face, fill, w, h) {
	let {p, dx, dy} = faceFrame(face);
	let out = new Uint8ClampedArray(w * h * 4);
	let axis = v => Math.abs(v.x) > 0.5 ? 'x' : Math.abs(v.y) > 0.5 ? 'y' : 'z';
	let ax = axis(dx), ay = axis(dy);
	let sx = Math.sign(dx[ax]), sy = Math.sign(dy[ay]);
	let s0 = Math.floor(p[ax]), t0 = Math.floor(p[ay]);
	for (let j = 0; j < h; j++) {
		let t = ((t0 + sy * j) % fill.height + fill.height) % fill.height;
		for (let i = 0; i < w; i++) {
			let s = ((s0 + sx * i) % fill.width + fill.width) % fill.width;
			let src = (t * fill.width + s) * 4, dst = (j * w + i) * 4;
			out[dst] = fill.data[src]; out[dst + 1] = fill.data[src + 1]; out[dst + 2] = fill.data[src + 2]; out[dst + 3] = fill.data[src + 3];
		}
	}
	return out;
}
// Whether a face's region differs from the plain fill of the material it is tagged with: hand paint to keep
function hasHandPaint(cube, key, atlas) {
	let face = cube.faces[key];
	if (face.texture != atlas.uuid) return false;
	let material = cube.game && getMaterial(cube.game[tagKeys().material]);
	let fill = material && manifest_state.fills.get(material.name);
	if (!fill) return false;
	let [w, h] = faceTexels(cube, key);
	let x = Math.min(face.uv[0], face.uv[2]), y = Math.min(face.uv[1], face.uv[3]);
	if (Math.abs(face.uv[2] - face.uv[0]) != w || Math.abs(face.uv[3] - face.uv[1]) != h) return true;
	let expected = fillPixels(face, fill, w, h);
	let actual = atlas.ctx.getImageData(x, y, w, h).data;
	for (let i = 0; i < expected.length; i++) if (expected[i] != actual[i]) return true;
	return false;
}

// Tag the cubes with the material and fill their faces. Faces keep their region when it already fits, so a
// refill repaints in place; otherwise a fresh region is allocated and the old one is simply no longer referenced.
export async function applyMaterial(cubes, name, options = {}) {
	cubes = cubes.filter(cube => cube instanceof Cube);
	let material = getMaterial(name);
	if (!material || !cubes.length) return null;
	let fill = await loadFill(material);
	if (!fill) return null;
	let atlas = getAtlas();
	await atlasReady(atlas);
	let keys = tagKeys();
	if (!options.force) {
		let painted = cubes.some(cube => Object.keys(cube.faces).some(key => hasHandPaint(cube, key, atlas)));
		if (painted) {
			let ok = await new Promise(resolve => Blockbench.showMessageBox({
				title: 'Refill painted faces?',
				message: 'Some of these faces carry paint over their fill. Applying the material paints the fill back over them.',
				buttons: ['Refill', 'Cancel'],
			}, button => resolve(button == 0)));
			if (!ok) return null;
		}
	}
	Undo.initEdit({elements: cubes, textures: [atlas], bitmap: true});
	let regions = usedRegions(atlas);
	let jobs = [];
	for (let cube of cubes) {
		cube.box_uv = false;
		if (!cube.game) cube.game = {};
		cube.game[keys.material] = material.name;
		for (let key in cube.faces) {
			let face = cube.faces[key];
			let [w, h] = faceTexels(cube, key);
			let own = regions.find(r => r.face == face);
			let rect = own && own.w == w && own.h == h ? own : null;
			while (!rect) {
				rect = allocateRegion(regions, w, h, atlas.width);
				if (!rect && !growAtlas(atlas)) {
					Undo.cancelEdit();
					Blockbench.showMessageBox({title: 'Atlas full', message: `The atlas is at its largest (${atlas.width}) and a ${w} x ${h} face does not fit.`});
					return null;
				}
			}
			if (rect != own) {
				if (own) regions.splice(regions.indexOf(own), 1);
				rect.face = face;
				regions.push(rect);
			}
			face.uv = [rect.x, rect.y, rect.x + w, rect.y + h];
			face.rotation = 0;
			face.texture = atlas.uuid;
			jobs.push({face, rect, w, h});
		}
	}
	atlas.edit(canvas => {
		let ctx = canvas.getContext('2d');
		for (let {face, rect, w, h} of jobs) {
			ctx.putImageData(new ImageData(fillPixels(face, fill, w, h), w, h), rect.x, rect.y);
		}
	}, {no_undo: true});
	Canvas.updateView({elements: cubes, element_aspects: {uv: true, faces: true}});
	Undo.finishEdit(`Apply ${material.name}`);
	refreshPanel();
	return {cubes: cubes.length, faces: jobs.length, atlas: atlas.width};
}

// Name fallbacks the contract allows until the tags are set: wall.brick is brick, prop.* is a prop
Codecs.project.on('parsed', () => {
	if (Format.id != 'dew_scene' && Format.id != 'free') return;
	let keys = tagKeys();
	let names = new Set(getMaterials().map(material => material.name));
	for (let cube of Cube.all) {
		if (cube.game && cube.game[keys.material]) continue;
		let tail = cube.name.split('.').pop();
		if (names.has(tail)) {
			if (!cube.game) cube.game = {};
			cube.game[keys.material] = tail;
		}
	}
	for (let group of Group.all) {
		if (group.game && group.game[keys.kind]) continue;
		if (/^prop(\.|$)/.test(group.name)) {
			if (!group.game) group.game = {};
			group.game[keys.kind] = 'prop';
		}
	}
});

export function setGroupKind(group, kind) {
	if (!(group instanceof Group)) return;
	Undo.initEdit({outliner: true});
	if (!group.game) group.game = {};
	group.game[tagKeys().kind] = kind;
	Undo.finishEdit('Set group kind');
	refreshPanel();
}

// Save into the game repo: models/<name>/<Name>.bbmodel, the one place the fork writes there
export function saveToGame() {
	let name = (Project.name || 'cluster').replace(/\.bbmodel$/i, '').replace(/[^\w\- ]+/g, '_').trim() || 'cluster';
	let folder = PathModule.join(MATERIAL.GAME_DIR, MATERIAL.MODELS_DIR, name.toLowerCase());
	let file = name[0].toUpperCase() + name.slice(1) + '.bbmodel';
	let path = PathModule.join(folder, file);
	fs.mkdirSync(folder, {recursive: true});
	Project.save_path = path;
	Project.name = name;
	Codecs.project.write(Codecs.project.compile(), path);
	return path;
}

// Panel: the palette from the manifest, the selection's tags, and the atlas usage
function refreshPanel() {
	let vue = Panels.dew_materials && Panels.dew_materials.inside_vue;
	if (!vue) return;
	let keys = tagKeys();
	vue.materials = getMaterials().map(material => ({...material, swatch: fillPath(material).replace(/\\/g, '/') + '?' + manifest_state.mtime}));
	vue.selected = manifest_state.selected;
	vue.keys = keys;
	vue.kinds = keys.kinds;
	let cubes = Cube.selected;
	let tags = new Set(cubes.map(cube => (cube.game && cube.game[keys.material]) || ''));
	vue.cube_count = cubes.length;
	vue.cube_material = tags.size == 1 ? [...tags][0] : (tags.size ? 'mixed' : '');
	let group = Group.first_selected || (cubes[0] && cubes[0].parent instanceof Group ? cubes[0].parent : null);
	vue.group_name = group ? group.name : '';
	vue.group_kind = group && group.game ? (group.game[keys.kind] || '') : '';
	let usage = atlasUsage();
	vue.atlas_text = usage.size ? `atlas ${usage.size} x ${usage.size}, ${Math.round(usage.fraction * 100)}% used` : 'no atlas yet';
	vue.manifest_ok = !!readManifest();
}
export function selectMaterial(name) {
	manifest_state.selected = getMaterial(name) ? name : null;
	refreshPanel();
}

let material_panel = new Panel('dew_materials', {
	name: 'Materials',
	icon: 'texture',
	condition: () => Format.id == 'dew_scene',
	default_position: {slot: 'right_bar', float_position: [0, 0], float_size: [300, 400], height: 380},
	growable: true,
	resizable: true,
	component: {
		data() {
			return {materials: [], selected: null, keys: {material: 'material', kind: 'kind'}, kinds: ['fabric', 'prop'],
				cube_count: 0, cube_material: '', group_name: '', group_kind: '', atlas_text: '', manifest_ok: true};
		},
		methods: {
			pick(material) { selectMaterial(material.name); },
			apply(material) {
				selectMaterial(material.name);
				if (Cube.selected.length) applyMaterial(Cube.selected, material.name);
			},
			applySelected() { if (manifest_state.selected && Cube.selected.length) applyMaterial(Cube.selected, manifest_state.selected); },
			setKind(event) {
				let group = Group.first_selected || (Cube.selected[0] && Cube.selected[0].parent instanceof Group ? Cube.selected[0].parent : null);
				if (group) setGroupKind(group, event.target.value);
			},
			reload() { manifest_state.mtime = 0; refreshPanel(); },
			save() { let path = saveToGame(); Blockbench.showQuickMessage(`Saved ${path}`, MATERIAL.MESSAGE_TIME); },
			tip(material) {
				return `${material.name}: hardness ${material.hardness}, density ${material.density_kg_m3} kg/m3, fuel ${material.fuel_turns} turns`
					+ (material.transparent ? ', transparent' : '') + (material.sheet ? ', sheet' : '') + (material.dents ? ', dents' : '')
					+ '\nClick to pick, double click to apply to the selected cubes';
			},
		},
		template: `
			<div style="padding: 4px 8px; display: flex; flex-direction: column; gap: 6px; height: 100%;">
				<p v-if="!manifest_ok" style="color: var(--color-error)">materials.json not found under the game folder</p>
				<ul style="display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 6px; list-style: none; padding: 0; margin: 0;">
					<li v-for="material in materials" :key="material.name" :title="tip(material)"
						@click="pick(material)" @dblclick="apply(material)"
						style="cursor: pointer; text-align: center; padding: 3px; border-radius: 4px; border: 2px solid transparent;"
						:style="{borderColor: material.name == selected ? 'var(--color-accent)' : 'transparent', background: 'var(--color-back)'}">
						<div :style="{backgroundImage: 'url(' + material.swatch + ')', backgroundSize: '64px 64px', imageRendering: 'pixelated', width: '56px', height: '56px', margin: '0 auto'}"></div>
						<div style="font-size: 12px; margin-top: 2px;">{{ material.name }}</div>
					</li>
				</ul>
				<div style="display: flex; gap: 6px; align-items: center;">
					<button @click="applySelected()" :disabled="!selected || !cube_count">Apply {{ selected || '' }} to {{ cube_count }} cube{{ cube_count == 1 ? '' : 's' }}</button>
				</div>
				<div v-if="cube_count" style="font-size: 12px;">Selected cube material: <b>{{ cube_material || 'none' }}</b></div>
				<div v-if="group_name" style="font-size: 12px; display: flex; gap: 6px; align-items: center;">
					<span>Group <b>{{ group_name }}</b> kind:</span>
					<select :value="group_kind" @change="setKind($event)">
						<option value="">untagged (fabric)</option>
						<option v-for="kind in kinds" :key="kind" :value="kind">{{ kind }}</option>
					</select>
				</div>
				<div style="font-size: 12px; color: var(--color-subtle_text); margin-top: auto; display: flex; gap: 8px; align-items: center;">
					<span>{{ atlas_text }}</span>
					<button style="margin-left: auto" @click="reload()" title="Re-read materials.json">Reload</button>
					<button @click="save()" title="Save into the game repo, models/<name>/<Name>.bbmodel">Save to game</button>
				</div>
			</div>
		`,
	},
});
Blockbench.on('update_selection', refreshPanel);
Blockbench.on('select_project', refreshPanel);
Blockbench.on('finished_edit', refreshPanel);

// The brush: click a cube to tag and fill it with the picked material, Alt picks a cube's material up
let brush_hover = null;
function cubeUnder(preview, event) {
	let data = preview.raycast(event);
	return data && data.type == 'element' && data.element instanceof Cube ? data.element : null;
}
function onMaterialHover(event) {
	let preview = event.target && event.target.preview;
	let cube = preview && preview.camera && Format.id == 'dew_scene' ? cubeUnder(preview, event) : null;
	if (brush_hover && brush_hover != cube && brush_hover.mesh) brush_hover.preview_controller.updateHighlight(brush_hover, null);
	brush_hover = cube;
	if (cube && cube.mesh) cube.preview_controller.updateHighlight(cube, cube);
}
BARS.defineActions(function() {
	new Tool('dew_material_brush', {
		name: 'Material Brush',
		description: 'Click a cube to tag it with the material picked in the Materials panel and fill its faces from the game\'s fill tile. Alt picks up the material a cube carries',
		icon: 'format_color_fill',
		category: 'tools',
		transformerMode: 'hidden',
		selectElements: false,
		cursor: 'crosshair',
		modes: ['edit'],
		condition: () => Modes.edit && Format.id == 'dew_scene',
		onCanvasClick(data) {
			let event = data && data.event;
			if (!event || event.button !== 0) return;
			let cube = cubeUnder(Preview.selected, event);
			if (!cube) return;
			if (event.altKey) {
				let name = cube.game && cube.game[tagKeys().material];
				if (name) { selectMaterial(name); Blockbench.showQuickMessage(`Picked ${name}`, MATERIAL.MESSAGE_TIME); }
				else Blockbench.showQuickMessage('No material on that cube', MATERIAL.MESSAGE_TIME);
				return;
			}
			if (!manifest_state.selected) return Blockbench.showQuickMessage('Pick a material in the Materials panel first', MATERIAL.MESSAGE_TIME);
			applyMaterial([cube], manifest_state.selected);
		},
		onSelect() {
			document.addEventListener('mousemove', onMaterialHover);
		},
		onUnselect() {
			document.removeEventListener('mousemove', onMaterialHover);
			if (brush_hover && brush_hover.mesh) brush_hover.preview_controller.updateHighlight(brush_hover, null);
			brush_hover = null;
		},
	});
	new Action('dew_apply_material', {
		name: 'Apply Material',
		description: 'Tag the selected cubes with the picked material and fill their faces',
		icon: 'format_color_fill',
		category: 'edit',
		condition: () => Format.id == 'dew_scene' && Cube.selected.length,
		click() {
			if (!manifest_state.selected) return Blockbench.showQuickMessage('Pick a material in the Materials panel first', MATERIAL.MESSAGE_TIME);
			applyMaterial(Cube.selected, manifest_state.selected);
		},
	});
	new Action('dew_save_to_game', {
		name: 'Save to Game Folder',
		description: 'Save this scene into the game repo as models/<name>/<Name>.bbmodel',
		icon: 'save_alt',
		category: 'file',
		condition: () => Format.id == 'dew_scene',
		click() {
			let path = saveToGame();
			Blockbench.showQuickMessage(`Saved ${path}`, MATERIAL.MESSAGE_TIME);
		},
	});
});

Object.assign(window, {DEWMaterial: {MATERIAL, manifest_state, getMaterials, getMaterial, tagKeys, getAtlas, applyMaterial, selectMaterial, setGroupKind, saveToGame, atlasUsage, hasHandPaint, loadFill}});
