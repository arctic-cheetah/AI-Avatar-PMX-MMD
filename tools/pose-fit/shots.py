# Usage in Blender: set KEEP (object names to render), HEAD_Z, TOP_Z, CX, CY, PREFIX, then exec this file.
import bpy, math, os
from mathutils import Vector
OUT = globals().get("OUT") or os.environ.get("POSE_FIT_TILES", "")
assert OUT, "Set OUT (tile folder) before exec(), or POSE_FIT_TILES."
s = bpy.context.scene
saved = {ob_.name: ob_.hide_render for ob_ in s.objects}
for ob_ in s.objects:
    if ob_.type in {'MESH','CURVE','FONT','SURFACE','GPENCIL','GREASEPENCIL'} and ob_.name not in KEEP:
        ob_.hide_render = True
old_cam = s.camera
cd = bpy.data.cameras.new("_shotcam"); cd.type = 'PERSP'; cd.lens = 85; cd.sensor_fit = 'VERTICAL'; cd.sensor_height = 36; cd.clip_start = 0.01; cd.clip_end = 100
cam = bpy.data.objects.new("_shotcam", cd); s.collection.objects.link(cam); s.camera = cam
r = s.render; _old_r = (r.resolution_x, r.resolution_y, r.resolution_percentage, r.filepath, r.film_transparent)
r.resolution_x = r.resolution_y = RES; r.resolution_percentage = 100; r.film_transparent = False
T = TOP_Z; H = HEAD_Z
framings = {
  "face": ((H + T) / 2 - 0.12 * (T - H), (T - H) * 0.72),
  "bust": (T - 0.19 * T, 0.21 * T),
  "full": (T * 0.5, 0.54 * T),
}
framings = globals().get("FRAMINGS") or framings
views = {"front": 0.0, "threequarter": 35.0, "side": 90.0}
done = []
ONLY_ = globals().get('ONLY')
for fname, (cz, half) in framings.items():
    for vname, ang in views.items():
        if ONLY_ and f'{fname}_{vname}' not in ONLY_: continue
        a = math.radians(ang)
        d = Vector((-math.sin(a)*FWD, -math.cos(a)*FWD, 0))
        target = Vector((CX, globals().get("CYS", {}).get(fname, CY), cz))
        cam.location = target + d * (half / math.tan(math.atan(18 / 85)))
        cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
        r.filepath = os.path.join(OUT, f"{PREFIX}_{fname}_{vname}.png")
        bpy.ops.render.render(write_still=True)
        done.append(r.filepath)
r.resolution_x, r.resolution_y, r.resolution_percentage, r.filepath, r.film_transparent = _old_r
s.camera = old_cam
bpy.data.objects.remove(cam); bpy.data.cameras.remove(cd)
for ob_ in s.objects:
    if ob_.name in saved: ob_.hide_render = saved[ob_.name]
print("rendered", len(done))
