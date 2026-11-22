# Re-attach "[Yidhari] Head Controller" to the 頭 bone with a Child Of constraint
# instead of a bone parent (#247).
# A mesh parented to the armature makes mmd_tools' Model.firstMesh() return the controller,
# so export_vpd writes no morphs. The controller keeps its world transform and still
# follows the head, which the Goo faceLogic needs.
# Live:       exec(open('tools/pose-fit/fix_head_controller.py').read())
# Background: blender -b file.blend --python tools/pose-fit/fix_head_controller.py -- --save
import bpy, sys

arm = bpy.data.objects['伊德海莉_arm']
hc = bpy.data.objects['[Yidhari] Head Controller']
vl = bpy.context.view_layer
vl.update()
if hc.parent is None and any(c.type == 'CHILD_OF' and c.subtarget == '頭' for c in hc.constraints):
    print('head controller: already uses Child Of, nothing to do')
else:
    mw = hc.matrix_world.copy()
    hc.parent = None
    hc.matrix_world = mw
    for c in [c for c in hc.constraints if c.type == 'CHILD_OF']:
        hc.constraints.remove(c)
    c = hc.constraints.new('CHILD_OF'); c.name = 'Follow 頭'
    c.target = arm; c.subtarget = '頭'
    vl.update()
    # Inverse of the head's current world matrix, so the controller stays where it is now.
    c.inverse_matrix = (arm.matrix_world @ arm.pose.bones['頭'].matrix).inverted()
    vl.update()
    drift = max(abs(a - b) for ra, rb in zip(hc.matrix_world, mw) for a, b in zip(ra, rb))
    print('head controller: now Child Of 頭, drift %.2e' % drift)

try:
    from bl_ext.blender_org.mmd_tools.core.model import Model
    print('mmd_tools firstMesh:', Model(bpy.data.objects['伊德海莉']).firstMesh().name)
except Exception as e:  # mmd_tools not enabled (e.g. --factory-startup)
    print('mmd_tools check skipped:', e)

if '--save' in sys.argv:
    bpy.context.preferences.filepaths.save_version = 0   # no .blend1 backup
    bpy.ops.wm.save_mainfile()
    print('saved', bpy.data.filepath)
