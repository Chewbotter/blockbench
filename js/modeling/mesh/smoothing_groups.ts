import { Interface } from '../../interface/interface';

/**
 * Smoothing groups UI: a grid of 30 buttons under the Element panel that assigns
 * smoothing groups (a bitmask on MeshFace.smoothing_group) to the selected mesh faces.
 * Click toggles a group on the selection, Shift+click makes it the only group.
 */

const GROUP_COUNT = 30;

function selectedFaces(): {mesh: Mesh, face: MeshFace}[] {
	let result: {mesh: Mesh, face: MeshFace}[] = [];
	for (let mesh of Mesh.selected) {
		for (let fkey of mesh.getSelectedFaces()) {
			let face = mesh.faces[fkey];
			if (face) result.push({mesh, face});
		}
	}
	return result;
}

function changeGroups(modify: (current: number) => number, message: string) {
	let faces = selectedFaces();
	if (!faces.length) return;
	let meshes = Mesh.selected.slice();
	Undo.initEdit({elements: meshes});
	for (let {face} of faces) {
		face.smoothing_group = modify(face.smoothing_group || 0);
	}
	Undo.finishEdit(message);
	Canvas.updateView({elements: meshes, element_aspects: {geometry: true}});
	updateButtons();
}

let container: HTMLElement;
let buttons: HTMLElement[] = [];

function build() {
	buttons = [];
	let grid = Interface.createElement('div', {class: 'smoothing_group_buttons'});
	for (let i = 0; i < GROUP_COUNT; i++) {
		let bit = 1 << i;
		let button = Interface.createElement('div', {class: 'smoothing_group_button', title: tl('mesh.smoothing_groups.button', [i + 1])}, String(i + 1));
		button.addEventListener('click', (event: MouseEvent) => {
			let faces = selectedFaces();
			if (event.shiftKey) {
				changeGroups(() => bit, 'Set smoothing group');
			} else {
				let all_have = faces.every(({face}) => (face.smoothing_group || 0) & bit);
				changeGroups(current => all_have ? (current & ~bit) : (current | bit), 'Change smoothing groups');
			}
		});
		buttons.push(button);
		grid.append(button);
	}
	let clear = Interface.createElement('div', {class: 'smoothing_group_button smoothing_group_clear', title: tl('mesh.smoothing_groups.clear.desc')}, tl('mesh.smoothing_groups.clear'));
	clear.addEventListener('click', () => changeGroups(() => 0, 'Clear smoothing groups'));
	container = Interface.createElement('div', {id: 'smoothing_groups', class: 'smoothing_groups'}, [
		Interface.createElement('label', {title: tl('mesh.smoothing_groups.desc')}, tl('mesh.smoothing_groups')),
		grid,
		clear,
	]);
	container.hidden = true;
}

function updateButtons() {
	if (!container) build();
	let panel = Panels.element;
	if (panel && container.parentElement != panel.node) panel.node.append(container);

	let faces = Modes.edit ? selectedFaces() : [];
	container.hidden = faces.length == 0;
	if (container.hidden) return;
	buttons.forEach((button, i) => {
		let bit = 1 << i;
		let count = faces.filter(({face}) => (face.smoothing_group || 0) & bit).length;
		button.classList.toggle('active', count == faces.length);
		button.classList.toggle('partial', count > 0 && count < faces.length);
	});
}

Blockbench.on('update_selection', updateButtons);
Blockbench.on('select_mode', updateButtons);
Blockbench.on('undo', updateButtons);
Blockbench.on('redo', updateButtons);
