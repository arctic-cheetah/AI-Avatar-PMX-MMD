# Add viewport-only "Hide: <part>" Mask modifiers to the PMX mesh (#247).
# Each mask hides one body part. Toggle it with the monitor icon (Modifiers) or the eye
# (Outliner). Never apply them: that would delete the part and its shape keys.
# Live:       exec(open('tools/pose-fit/add_hide_masks.py').read())
# Background: blender -b file.blend --python tools/pose-fit/add_hide_masks.py -- --save
# Before a PMX export, delete the focus_* vertex groups and the Hide: modifiers.
import bpy, collections, sys

o = bpy.data.objects['伊德海莉_mesh']
arm = bpy.data.objects['伊德海莉_arm']
bones = {b.name for b in arm.data.bones}
vg = {g.index: g.name for g in o.vertex_groups}


def region(nm):
    b = nm.split('.')[0]
    if 'Tail' in nm: return 'Tails'
    if 'Hair' in nm or 'Hat' in nm: return 'Hair & hat'
    if b in ('頭', '首', '口', '口中', '齿下', '齿上', '目', '目光'): return 'Head'
    if '指' in b or any(k in b for k in ('腕', 'ひじ', '手', '肩', 'Clavicle')):
        return 'Right arm' if nm.endswith('.R') or nm.startswith('Skn_R') else 'Left arm'
    if any(k in b for k in ('足', 'ひざ', '尻', 'FootRing')): return 'Legs'
    if any(k in nm for k in ('Chain', 'Bag', 'Badge', 'Daizi', '结')): return 'Accessories'
    return 'Torso'


groups = collections.defaultdict(list)
for v in o.data.vertices:
    gs = [g for g in v.groups if vg[g.group] in bones]
    groups[region(vg[max(gs, key=lambda g: g.weight).group]) if gs else 'Torso'].append(v.index)

ORDER = ['Tails', 'Legs', 'Hair & hat', 'Left arm', 'Right arm', 'Accessories', 'Torso', 'Head']
for r in ORDER:
    gname = 'focus_' + r.lower().replace(' & ', '_').replace(' ', '_')
    g = o.vertex_groups.get(gname) or o.vertex_groups.new(name=gname)
    g.add(groups[r], 1.0, 'REPLACE')
    m = o.modifiers.get('Hide: ' + r) or o.modifiers.new('Hide: ' + r, 'MASK')
    m.mode = 'VERTEX_GROUP'; m.vertex_group = gname; m.invert_vertex_group = True; m.threshold = 0.5
    m.show_viewport = False; m.show_render = False; m.show_in_editmode = False; m.show_expanded = False

# Order: armature first, then the masks, then anything else (e.g. the Goo modifiers).
names = ['mmd_armature'] + ['Hide: ' + r for r in ORDER]
for i, n in enumerate(names):
    with bpy.context.temp_override(object=o, active_object=o):
        bpy.ops.object.modifier_move_to_index(modifier=n, index=i)

print('masks:', {r: len(groups[r]) for r in ORDER})
print('modifiers:', [m.name for m in o.modifiers])
if '--save' in sys.argv:
    bpy.context.preferences.filepaths.save_version = 0   # no .blend1 backup
    bpy.ops.wm.save_mainfile()
    print('saved', bpy.data.filepath)
