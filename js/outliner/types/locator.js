
export class Locator extends OutlinerElement {
	constructor(data, uuid) {
		super(data, uuid);

		for (var key in Locator.properties) {
			Locator.properties[key].reset(this);
		}

		if (data) {
			this.extend(data);
		}
	}
	get origin() {
		return this.position;
	}
	extend(object) {
		if (object.from) this.position.V3_set(object.from);
		for (var key in Locator.properties) {
			Locator.properties[key].merge(this, object)
		}
		this.sanitizeName();
		Merge.boolean(this, object, 'export');
		return this;
	}
	init() {
		if (this.parent instanceof Group == false) {
			this.addTo(Group.first_selected)
		}
		super.init();
		return this;
	}
	flip(axis, center) {
		var offset = this.position[axis] - center
		this.position[axis] = center - offset;
		this.rotation.forEach((n, i) => {
			if (i != axis) this.rotation[i] = -n;
		})
		// Name
		flipNameOnAxis(this, axis);

		this.createUniqueName();
		this.preview_controller.updateTransform(this);
		return this;
	}
	getWorldCenter() {
		var pos = new THREE.Vector3();
		var q = Reusable.quat1.set(0, 0, 0, 1);
		if (this.parent instanceof Group) {
			THREE.fastWorldPosition(this.parent.mesh, pos);
			this.parent.mesh.getWorldQuaternion(q);
			var offset2 = Reusable.vec2.fromArray(this.parent.origin).applyQuaternion(q);
			pos.sub(offset2);
		}
		var offset = Reusable.vec3.fromArray(this.position).applyQuaternion(q);
		pos.add(offset);

		return pos;
	}
	static behavior = {
		unique_name: true,
		movable: true,
		rotatable: true,
	}
}
	Locator.prototype.title = tl('data.locator');
	Locator.prototype.type = 'locator';
	Locator.prototype.icon = 'fa-anchor';
	Locator.prototype.name_regex = () => Format.node_name_regex ?? 'a-zA-Z0-9_',
	Locator.prototype.visibility = true;
	Locator.prototype.buttons = [
		Outliner.buttons.export,
		Outliner.buttons.locked,
		Outliner.buttons.visibility,
	];
	Locator.prototype.menu = new Menu([
			...Outliner.control_menu_group,
			new MenuSeparator('settings'),
			new MenuSeparator('manage'),
			'rename',
			'toggle_visibility',
			'delete'
		])
	
new Property(Locator, 'string', 'name', {default: 'locator'})
new Property(Locator, 'vector', 'position')
new Property(Locator, 'vector', 'rotation')
new Property(Locator, 'boolean', 'ignore_inherited_scale', {
	inputs: {
		element_panel: {
			input: {label: 'menu.locator.ignore_inherited_scale', description: 'cube.rescale.desc', type: 'checkbox'},
		}
	}
})
new Property(Locator, 'boolean', 'visibility', {default: true});
new Property(Locator, 'boolean', 'locked');

OutlinerElement.registerType(Locator, 'locator');


const LOCATOR_ARROW = {
	PIXELS: 44,
	HEAD_START: 0.62,
	SHAFT_HALF_WIDTH: 0.09,
	HEAD_HALF_WIDTH: 0.27,
	DEPTH: 0.1,
	SIDE_SHADE: 0.55,
	SELECTED_ORDER: 100,
};
let locator_scene = null;
const locator_view_position = new THREE.Vector3();
function hookLocatorRender() {
	if (locator_scene === Canvas.scene) return;
	locator_scene = Canvas.scene;
	const previous = Canvas.scene.onBeforeRender;
	Canvas.scene.onBeforeRender = function(renderer, scene, camera, ...rest) {
		previous.call(this, renderer, scene, camera, ...rest);
		if (!camera.preview) return;
		for (const locator of Locator.all) {
			if (locator.mesh?.visible) locator.preview_controller.updateWindowSize(locator, camera.preview);
		}
	};
}

function createLocatorArrow() {
	// Tail at the pivot, tip along local +X, the game's hinge/hinger rotation axis.
	const {HEAD_START: h, SHAFT_HALF_WIDTH: s, HEAD_HALF_WIDTH: w, DEPTH: d} = LOCATOR_ARROW;
	const shape = new THREE.Shape();
	shape.moveTo(0, -s);
	for (const [x, y] of [[h, -s], [h, -w], [1, 0], [h, w], [h, s], [0, s]]) shape.lineTo(x, y);
	shape.closePath();
	const geometry = new THREE.ExtrudeGeometry(shape, {depth: d, steps: 1, bevelEnabled: false});
	geometry.translate(0, 0, -d / 2);
	const materials = [1, LOCATOR_ARROW.SIDE_SHADE].map(shade => new THREE.MeshBasicMaterial({
		color: gizmo_colors.r.clone().multiplyScalar(shade), depthWrite: false,
	}));
	const arrow = new THREE.Mesh(geometry, materials);
	arrow.no_export = true;
	return arrow;
}

new NodePreviewController(Locator, {
	setup(element) {
		let mesh = new THREE.Object3D();
		Project.nodes_3d[element.uuid] = mesh;
		mesh.name = element.uuid;
		mesh.type = element.type;
		mesh.isElement = true;
		mesh.visible = element.visibility;
		mesh.rotation.order = Format.euler_order;

		const arrow = createLocatorArrow();
		arrow.name = element.uuid;
		arrow.type = element.type;
		arrow.isElement = true;
		mesh.add(arrow);
		mesh.locator_marker = arrow;

		hookLocatorRender();
		this.updateTransform(element);
		this.updateSelection(element);

		this.dispatchEvent('setup', {element});
	},
	updateTransform(element) {
		NodePreviewController.prototype.updateTransform.call(this, element);
		this.updateWindowSize(element);
	},
	updateSelection(element) {
		let {mesh} = element;

		const arrow = mesh.locator_marker;
		arrow.material.forEach((material, i) => {
			material.color.copy(element.selected ? gizmo_colors.outline : gizmo_colors.r);
			if (i) material.color.multiplyScalar(LOCATOR_ARROW.SIDE_SHADE);
			material.depthTest = !element.selected;
		});
		arrow.renderOrder = element.selected ? LOCATOR_ARROW.SELECTED_ORDER : 0;

		this.dispatchEvent('update_selection', {element});
	},
	updateWindowSize(element, preview = Preview.selected) {
		if (!preview?.height) return;
		const {camera} = preview;
		const {mesh} = element;
		mesh.getWorldPosition(locator_view_position).applyMatrix4(camera.matrixWorldInverse);
		// Scale the preview child only. The saved locator retains its original transform.
		let size = LOCATOR_ARROW.PIXELS * 2 / (preview.height * camera.projectionMatrix.elements[5]);
		if (camera.isPerspectiveCamera) size *= Math.abs(locator_view_position.z);
		mesh.locator_marker.scale.setScalar(Math.max(size, 1e-7));
		mesh.locator_marker.updateMatrixWorld(true);
	},
	remove(element) {
		const arrow = element.mesh?.locator_marker;
		if (arrow) {
			arrow.geometry.dispose();
			arrow.material.forEach(material => material.dispose());
		}
		NodePreviewController.prototype.remove.call(this, element);
	}
})

let locator_suggestion_list = $('<datalist id="locator_suggestion_list" hidden></datalist>').get(0);
document.body.append(locator_suggestion_list);

Locator.updateAutocompleteList = function() {
	locator_suggestion_list.innerHTML = '';
	Locator.all.forEach(locator => {
		let option = document.createElement('option');
		option.value = locator.name;
		locator_suggestion_list.append(option);
	})
}



BARS.defineActions(function() {
	new Action('add_locator', {
		icon: 'fa-anchor',
		category: 'edit',
		condition: () => {return Format.locators && Modes.edit},
		click: function () {
			var objs = []
			Undo.initEdit({elements: objs, outliner: true});
			var locator = new Locator().addTo(Group.first_selected||Outliner.selected[0]).init();
			locator.select().createUniqueName();
			objs.push(locator);
			Undo.finishEdit('Add locator');
			Vue.nextTick(function() {
				if (settings.create_rename.value) {
					locator.rename();
				}
			})
		}
	})
})
Object.assign(window, {
	Locator
});
