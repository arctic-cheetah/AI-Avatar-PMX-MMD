# Background Goo: export posed + rest world vertex positions of the reference game meshes.
import bpy, numpy as np, sys
out=sys.argv[-1]
dg=bpy.context.evaluated_depsgraph_get
rig=bpy.data.objects['RIG-Yidhari']
names=['Body','Tentacles','Hair','Face','Chain','Necklace']
for n in names:
    for m in bpy.data.objects[n].modifiers:
        if m.type=='NODES': m.show_viewport=False; m.show_render=False
data={}
def world_positions(o):
    e=o.evaluated_get(dg()); me=e.to_mesh()
    mw=np.array(o.matrix_world)
    co=np.empty(len(me.vertices)*3,dtype=np.float32); me.vertices.foreach_get('co',co); co=co.reshape(-1,3)
    co=co@mw[:3,:3].T+mw[:3,3]
    e.to_mesh_clear(); return co
for mode in ('POSE','REST'):
    rig.data.pose_position=mode
    bpy.context.view_layer.update()
    for n in names:
        data[f'{n}:{mode}']=world_positions(bpy.data.objects[n])
rig.data.pose_position='POSE'
for n in names:
    me=bpy.data.objects[n].data
    lv=np.empty(len(me.loops),dtype=np.int32); me.loops.foreach_get('vertex_index',lv)
    uv=np.empty(len(me.loops)*2,dtype=np.float32); me.uv_layers['UV0'].data.foreach_get('uv',uv)
    lm=np.empty(len(me.loops),dtype=np.int32)
    for p in me.polygons: lm[p.loop_start:p.loop_start+p.loop_total]=p.material_index
    data[f'{n}:loopvert']=lv; data[f'{n}:uv']=uv.reshape(-1,2); data[f'{n}:loopmat']=lm
    data[f'{n}:mats']=np.array([m.name for m in me.materials])
    print(n, len(me.vertices), "max move", float(np.linalg.norm(data[f'{n}:POSE']-data[f'{n}:REST'],axis=1).max()))
sk=bpy.data.objects['Face'].data.shape_keys
data['face_keys']=np.array([f'{k.name}={k.value:.4f}' for k in sk.key_blocks if k.value>0 and k.name!=sk.reference_key.name])
print(list(data['face_keys']))
# key bone heads for diagnostics
bones={}
for b in rig.pose.bones:
    if b.name.startswith('DEF-'): bones[b.name]=np.array(list(rig.matrix_world@b.head)+list(rig.matrix_world@b.tail))
data['def_names']=np.array(list(bones)); data['def_ht']=np.array(list(bones.values()))
np.savez(out,**data); print("saved",out)
