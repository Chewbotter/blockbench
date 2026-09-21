import { Blockbench } from "../api";
import { openTouchKeyboardModifierMenu } from "./interface";
import { isMac } from "./keyboard";

onVueSetup(function() {
	Interface.status_bar.vue = new Vue({
		el: '#status_bar',
		data: {
			Prop,
			isMobile: Blockbench.isMobile,
			streamer_mode: settings.streamer_mode.value,
			selection_info: '',
			poly_info: '',		// triangles drawn, selected / scene, updated with the selection
			Format: null,
			show_modifier_keys: settings.status_bar_modifier_keys.value,
			warnings: Validator.warnings,
			errors: Validator.errors,
			modifier_keys: {
				ctrl: [],
				shift: [],
				alt: []
			},
			modifiers: Blockbench.isTouch && !Blockbench.isMobile && Pressing.overrides,
			keyboard_menu_in_status_bar: Blockbench.isTouch && !Blockbench.isMobile
		},
		methods: {
			showContextMenu(event: MouseEvent) {
				if ((event.target as HTMLElement).closest('.toolbar')) return;
				Interface.status_bar.menu.show(event);
			},
			toggleStreamerMode() {
				ActionControl.select(`setting: ${tl('settings.streamer_mode')}`);
			},
			// Triangles an element draws: a cube face is two unless it is disabled (texture null), a mesh face with n
			// corners is n - 2, anything else (splines, locators) counts nothing
			countTriangles(elements: OutlinerElement[]) {
				let tris = 0;
				for (let element of elements) {
					if (element instanceof Cube) {
						for (let key in element.faces) if (element.faces[key].texture !== null) tris += 2;
					} else if (element instanceof Mesh) {
						for (let key in element.faces) tris += Math.max(0, element.faces[key].vertices.length - 2);
					}
				}
				return tris;
			},
			updatePolyInfo() {
				if (!Modes.edit && !Modes.paint) { this.poly_info = ''; return; }
				let total = this.countTriangles(Outliner.elements.filter(element => element.visibility !== false && element.export !== false));
				let selected = Outliner.selected.length ? this.countTriangles(Outliner.selected) : 0;
				let fmt = (n: number) => n.toLocaleString('en-US');
				this.poly_info = Outliner.selected.length ? `${fmt(selected)} / ${fmt(total)} tris` : `${fmt(total)} tris`;
			},
			updateSelectionInfo() {
				this.updatePolyInfo();
				let selection_mode = BarItems.selection_mode.value;
				let spline_selection_mode = (BarItems.spline_selection_mode as BarSelect).value;
				if (Modes.edit && Mesh.selected.length && selection_mode !== 'object') {
					if (selection_mode == 'face') {
						let total = 0, selected = 0;
						Mesh.selected.forEach(mesh => {
							total += Object.keys(mesh.faces).length;
							selected += mesh.getSelectedFaces().length;
						});
						this.selection_info = tl('status_bar.selection.faces', `${selected} / ${total}`);
					}
					if (selection_mode == 'edge') {
						let total = 0, selected = 0;
						Mesh.selected.forEach(mesh => {
							let processed_lines = new Set();
							mesh.forAllFaces(face => {
								let vertices = face.getSortedVertices();
								vertices.forEach((vkey, i) => {
									let vkey2 = vertices[i+1] || vertices[0];
									// Count shared edges once without searching every edge already visited on each drag step.
									processed_lines.add(JSON.stringify(vkey < vkey2 ? [vkey, vkey2] : [vkey2, vkey]));
								})
							})
							total += processed_lines.size;
							selected += mesh.getSelectedEdges().length;
						})
						this.selection_info = tl('status_bar.selection.edges', `${selected} / ${total}`);
					}
					if (selection_mode == 'vertex' || selection_mode == 'weld') {
						let total = 0, selected = 0;
						Mesh.selected.forEach(mesh => total += Object.keys(mesh.vertices).length);
						Mesh.selected.forEach(mesh => selected += mesh.getSelectedVertices().length);
						this.selection_info = tl('status_bar.selection.vertices', `${selected} / ${total}`);
					}
				} else if (Modes.edit && SplineMesh.selected.length && spline_selection_mode !== 'object') {
					if (spline_selection_mode == 'handles') {
						let total = 0, selected = 0;
						SplineMesh.selected.forEach((spline: SplineMesh) => total += Object.keys(spline.vertices).length);
						SplineMesh.selected.forEach((spline: SplineMesh) => selected += spline.getSelectedVertices().length);
						this.selection_info = tl('status_bar.selection.vertices', `${selected} / ${total}`);
					}
					if (spline_selection_mode == "tilt") {
						this.selection_info = '';
					}
				} else {
					this.selection_info = '';
				}
			},
			clickModifiers() {
				ActionControl.select(`setting: ${tl('settings.status_bar_modifier_keys')}`);
			},
			openValidator() {
				Validator.openDialog();
			},
			openKeyboardMenu() {
				openTouchKeyboardModifierMenu(this.$refs.mobile_keyboard_menu);
			},
			toggleSidebar: Interface.toggleSidebar,
			getIconNode: Blockbench.getIconNode,
			tl
		},
		template: `
			<div id="status_bar" @contextmenu="showContextMenu($event)">
				<div class="sidebar_toggle_button" v-if="!isMobile" @click="toggleSidebar('left')" title="${tl('status_bar.toggle_sidebar')}">
					<i class="material-icons">{{Prop.show_left_bar ? 'chevron_left' : 'chevron_right'}}</i>
				</div>
				
				<div class="f_left" v-if="streamer_mode"
					style="background-color: var(--color-stream); color: var(--color-light);"
					@click="toggleStreamerMode()"
					title="${tl('interface.streamer_mode_on')}"
				>
					<i class="material-icons">live_tv</i>
				</div>
				<div v-if="Format" v-html="getIconNode(Format.icon).outerHTML" v-bind:title="Format.name"></div>
				<div v-if="Prop.recording" v-html="getIconNode('fiber_manual_record').outerHTML" style="color: var(--color-close)" title="${tl('status_bar.recording')}"></div>


				<div id="status_name">
					{{ Prop.file_name }}
				</div>
				<div id="status_message" class="hidden"></div>

				<template v-if="show_modifier_keys && !isMobile">
					<div class="status_bar_modifier_key" v-if="modifier_keys.ctrl.length" @click="clickModifiers()">
						<kbd>${tl(Blockbench.platform == 'darwin' ? 'keys.meta' : 'keys.ctrl')}</kbd>
						<span>{{ tl(modifier_keys.ctrl.last()) }}</span>
					</div>
					<div class="status_bar_modifier_key" v-if="modifier_keys.shift.length" @click="clickModifiers()">
						<kbd>${tl('keys.shift')}</kbd>
						<span>{{ tl(modifier_keys.shift.last()) }}</span>
					</div>
					<div class="status_bar_modifier_key" v-if="modifier_keys.alt.length" @click="clickModifiers()">
						<kbd>${tl(isMac ? 'keys.option' : 'keys.alt')}</kbd>
						<span>{{ tl(modifier_keys.alt.last()) }}</span>
					</div>
				</template>

				<div class="status_selection_info">{{ selection_info }}</div>
				<div class="status_selection_info" v-if="poly_info" title="Triangles drawn: selected / scene. Hidden elements and helpers marked not exported are left out of the scene count">{{ poly_info }}</div>

				<div class="f_right" id="validator_status" v-if="warnings.length || errors.length" @click="openValidator()">
					<span v-if="warnings.length" style="color: var(--color-warning)">{{ warnings.length }}<i class="material-icons">warning</i></span>
					<span v-if="errors.length" style="color: var(--color-error)">{{ errors.length }}<i class="material-icons">error</i></span>
				</div>

				<div id="status_bar_tool_controls" v-if="isMobile"></div>

				<div v-if="keyboard_menu_in_status_bar" id="mobile_keyboard_menu" @click="openKeyboardMenu()" ref="mobile_keyboard_menu" :class="{enabled: modifiers.ctrl || modifiers.shift || modifiers.alt}">
					<i class="material-icons">keyboard</i>
				</div>

				<div class="f_right fps_counter_display" v-if="!isMobile">
					{{ Prop.fps }} FPS
				</div>

				<div class="sidebar_toggle_button" v-if="!isMobile" @click="toggleSidebar('right')" title="${tl('status_bar.toggle_sidebar')}">
					<i class="material-icons">{{Prop.show_right_bar ? 'chevron_right' : 'chevron_left'}}</i>
				</div>

				<div id="status_progress" v-if="Prop.progress" v-bind:style="{width: Prop.progress*100+'%'}"></div>
			</div>
		`
	})

	Interface.addSuggestedModifierKey = (key, text) => {
		Interface.status_bar.vue.$data.modifier_keys[key].safePush(text);
	};
	Interface.removeSuggestedModifierKey = (key, text) => {
		Interface.status_bar.vue.$data.modifier_keys[key].remove(text);
	};

	
	Interface.status_bar.menu = new Menu([
		'project_window',
		'open_model_folder',
		'view_backups',
		'save',
		'cancel_gif',
	])
})
