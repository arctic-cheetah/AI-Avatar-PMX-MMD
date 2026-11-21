# Live Blender: map every PMX vertex to a game vertex (by UV0 + rest position), build target positions.
import bpy, numpy as np, json, collections
from mathutils import kdtree
import os
WORK = globals().get('WORK') or os.environ.get('POSE_FIT_DIR', '')
assert WORK, 'Set WORK (a folder for the .npz files) before exec(), or POSE_FIT_DIR.'
d=np.load(WORK+'/ref_targets.npz')
OFF=np.array([0,0,0.0486],dtype=np.float32)
o=bpy.data.objects['伊德海莉_mesh']; me=o.data
n=len(me.vertices)
rest=np.empty(n*3,dtype=np.float32); me.vertices.foreach_get('co',rest); rest=rest.reshape(-1,3)
gmap=json.loads(o['goo_material_map']); gmap['髮+']='Yidhari Hair'
orig=json.loads(o['goo_original_materials'])
slot_game=[gmap[m] for m in orig]
# game loops grouped by material: (uv, objname, vert)
objs=['Body','Tentacles','Hair','Face','Chain','Necklace']
bymat=collections.defaultdict(list)
for ob in objs:
    uv=d[ob+':uv']; lv=d[ob+':loopvert']; lm=d[ob+':loopmat']; mats=list(d[ob+':mats'])
    for i in range(len(lv)):
        bymat[mats[lm[i]]].append((uv[i,0],uv[i,1],ob,int(lv[i])))
kds={}
for m,l in bymat.items():
    kd=kdtree.KDTree(len(l)); [kd.insert((e[0],e[1],0),i) for i,e in enumerate(l)]; kd.balance(); kds[m]=kd
uvl=me.uv_layers['UVMap'].data
votes=[collections.Counter() for _ in range(n)]
for p in me.polygons:
    gm=slot_game[p.material_index]; kd=kds[gm]; l=bymat[gm]
    for li in p.loop_indices:
        vi=me.loops[li].vertex_index
        c=[x for x in kd.find_n((uvl[li].uv.x,uvl[li].uv.y,0),8) if x[2]<1/2048]
        if not c: continue
        # tie-break by rest distance (game REST + OFF vs PMX rest) for mirrored UV islands
        best=min(c,key=lambda x: float(np.linalg.norm(d[l[x[1]][2]+':REST'][l[x[1]][3]]+OFF-rest[vi])))
        votes[vi][(l[best[1]][2],l[best[1]][3])]+=1
tgt=np.full((n,3),np.nan,dtype=np.float32); restref=np.full((n,3),np.nan,dtype=np.float32); src=np.full(n,-1)
obidx={ob:i for i,ob in enumerate(objs)}
for vi,c in enumerate(votes):
    if c:
        (ob,gv),_=c.most_common(1)[0]
        tgt[vi]=d[ob+':POSE'][gv]+OFF; restref[vi]=d[ob+':REST'][gv]+OFF; src[vi]=obidx[ob]
ok=~np.isnan(tgt[:,0])
rd=np.linalg.norm(restref[ok]-rest[ok],axis=1)
print("mapped",ok.sum(),"/",n, "rest-dist p50 %.4f p90 %.4f max %.3f"%(np.median(rd),np.percentile(rd,90),rd.max()))
for i,ob in enumerate(objs):
    s=src==i; r=np.linalg.norm(restref[s]-rest[s],axis=1)
    if s.sum(): print(" ",ob,s.sum(),"rest-dist p50 %.4f p90 %.4f"%(np.median(r),np.percentile(r,90)))
np.savez(WORK+'/pmx_targets.npz',tgt=tgt,rest=rest,src=src,restref=restref)
