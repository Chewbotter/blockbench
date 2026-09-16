# Builds rig_fixture.glb for cdp_rig_import.mjs: a 0.5 x 2 x 0.5 box standing on the origin, skinned to two
# bones (root from y 0 to 1, tip from y 1 to 2, every vertex to the bone of its half), one flat red material,
# and one animation that bends the tip bone 45 degrees about its local X between frame 1 and frame 13.
# Run with Blender headless from the repo root:
#   "D:/Blender 5.2/blender.exe" --background --factory-startup --python tests/dew/fixtures/make_rig_fixture.py
import bpy, math, os

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rig_fixture.glb')
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# Mesh: a box standing on Blender's Z (the exporter turns that into glTF Y), split at height 1 so each half has
# its own vertices
verts = []
faces = []
for level, height in enumerate([0.0, 1.0, 2.0]):
    for x, y in [(-0.25, -0.25), (0.25, -0.25), (0.25, 0.25), (-0.25, 0.25)]:
        verts.append((x, y, height))
for level in range(2):
    b = level * 4
    for i in range(4):
        j = (i + 1) % 4
        faces.append((b + i, b + j, b + 4 + j, b + 4 + i))
faces.append((0, 3, 2, 1))
faces.append((8, 9, 10, 11))
mesh = bpy.data.meshes.new('box')
mesh.from_pydata(verts, [], faces)
mesh.update()
material = bpy.data.materials.new('red')
material.use_nodes = True
material.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.8, 0.1, 0.1, 1.0)
mesh.materials.append(material)
box = bpy.data.objects.new('box', mesh)
scene.collection.objects.link(box)

# Armature: root up from the origin, tip continuing from height 1
armature = bpy.data.armatures.new('rig')
rig = bpy.data.objects.new('rig', armature)
scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
root = armature.edit_bones.new('root')
root.head = (0, 0, 0)
root.tail = (0, 0, 1)
tip = armature.edit_bones.new('tip')
tip.head = (0, 0, 1)
tip.tail = (0, 0, 2)
tip.parent = root
bpy.ops.object.mode_set(mode='OBJECT')

# Weights: the lower half to root, the upper half to tip (the middle ring goes with the tip so the bend shows)
for name, picks in [('root', [i for i in range(12) if verts[i][2] < 0.5]), ('tip', [i for i in range(12) if verts[i][2] >= 0.5])]:
    group = box.vertex_groups.new(name=name)
    group.add(picks, 1.0, 'REPLACE')
modifier = box.modifiers.new('rig', 'ARMATURE')
modifier.object = rig
box.parent = rig

# Animation: the tip bends 45 degrees about its local X
scene.frame_start = 1
scene.frame_end = 13
scene.render.fps = 24
pose_tip = rig.pose.bones['tip']
pose_tip.rotation_mode = 'XYZ'
pose_tip.rotation_euler = (0, 0, 0)
pose_tip.keyframe_insert('rotation_euler', frame=1)
pose_tip.rotation_euler = (math.radians(45), 0, 0)
pose_tip.keyframe_insert('rotation_euler', frame=13)
rig.animation_data.action.name = 'bend'

bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_skins=True, export_animations=True, export_yup=True)
print('wrote', out)
