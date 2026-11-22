import bpy, numpy as np, collections
import os
WORK = globals().get('WORK') or os.environ.get('POSE_FIT_DIR', '')
assert WORK, 'Set WORK (a folder for the .npz files) before exec(), or POSE_FIT_DIR.'
z=np.load(WORK+'/pmx_targets.npz'); tgt=z['tgt']
o=bpy.data.objects['伊德海莉_mesh']; me=o.data; arm=bpy.data.objects['伊德海莉_arm']
saved=[(m,m.show_viewport) for m in o.modifiers]
for m in o.modifiers: m.show_viewport=(m.type=='ARMATURE')
bpy.context.view_layer.update()
e=o.evaluated_get(bpy.context.evaluated_depsgraph_get()); em=e.to_mesh()
co=np.empty(len(em.vertices)*3,dtype=np.float32); em.vertices.foreach_get('co',co); co=co.reshape(-1,3)
e.to_mesh_clear()
for m,v in saved: m.show_viewport=v
bpy.context.view_layer.update()
mw=np.array(o.matrix_world); co=co@mw[:3,:3].T+mw[:3,3]
ok=~np.isnan(tgt[:,0]); err=np.linalg.norm(co-tgt,axis=1)
bones={b.name for b in arm.data.bones}; vg={g.index:g.name for g in o.vertex_groups}
def region(nm):
    b=nm.split('.')[0]
    if 'Tail' in nm: return 'tails'
    if 'Hair' in nm or 'Hat' in nm: return 'hair/hat'
    if b in ('頭','首','口','口中','齿下','齿上','目','目光'): return 'head/face'
    if any(k in b for k in ('指',)): return 'fingers'
    if any(k in b for k in ('腕','ひじ','手','肩','Clavicle')): return 'arms'
    if any(k in b for k in ('足','ひざ','尻','FootRing')): return 'legs'
    if 'Chain' in nm or 'Bag' in nm or 'Badge' in nm or 'Daizi' in nm or '结' in nm: return 'accessories'
    return 'torso'
reg=np.empty(len(co),dtype=object)
for v in me.vertices:
    gs=[g for g in v.groups if vg[g.group] in bones]
    reg[v.index]=region(vg[max(gs,key=lambda g:g.weight).group]) if gs else 'none'
REPORT={}
for r in sorted(set(reg)):
    s=ok&(reg==r)
    if s.sum(): 
        x=err[s]*1000; REPORT[r]=(int(s.sum()),round(float(np.median(x)),1),round(float(np.percentile(x,90)),1),round(float(x.max()),1))
        print(f"{r:12s} n={s.sum():6d} median {np.median(x):6.1f} mm  p90 {np.percentile(x,90):6.1f} mm  max {x.max():7.1f} mm")
x=err[ok]*1000; print(f"ALL n={ok.sum()} median {np.median(x):.1f} mm p90 {np.percentile(x,90):.1f} max {x.max():.1f}")
np.save(WORK+'/eval_err.npy',err)
