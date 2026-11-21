# Live Blender, after fit_pose.py: put the leg IK targets where the fitted FK legs ended,
# then turn the IK / damped-track / limit-rotation constraints back on.
import bpy
arm = bpy.data.objects['伊德海莉_arm']; vl = bpy.context.view_layer
for side in ('.L', '.R'):
    ik = arm.pose.bones['足ＩＫ' + side]; toe = arm.pose.bones['つま先ＩＫ' + side]
    knee = arm.pose.bones['ひざ' + side]; ankle = arm.pose.bones['足首' + side]
    vl.update()
    for pb, want in ((ik, knee.tail.copy()), (toe, ankle.tail.copy())):
        pb.rotation_quaternion = (1, 0, 0, 0)
        M = pb.matrix.copy(); M.translation = want; pb.matrix = M; vl.update()
        print(pb.name, 'target error %.2e m' % (pb.head - want).length)
for pb in arm.pose.bones:
    for c in pb.constraints:
        if c.type in ('IK', 'DAMPED_TRACK', 'LIMIT_ROTATION'): c.mute = False
vl.update()
