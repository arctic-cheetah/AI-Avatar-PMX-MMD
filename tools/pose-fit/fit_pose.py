# Live Blender: fit PMX FK bone rotations (+ センター translation) to target vertex positions.
import bpy, numpy as np, collections
from mathutils import Matrix, Vector, Quaternion
import os
WORK = globals().get('WORK') or os.environ.get('POSE_FIT_DIR', '')
assert WORK, 'Set WORK (a folder for the .npz files) before exec(), or POSE_FIT_DIR.'
z=np.load(WORK+'/pmx_targets.npz'); tgt=z['tgt']; rest=z['rest']
arm=bpy.data.objects['伊德海莉_arm']; o=bpy.data.objects['伊德海莉_mesh']; me=o.data
vl=bpy.context.view_layer
# --- which controlling bone owns each deform group
def ctrl_of(name):
    for suf in ('.L','.R'):
        if name.endswith(suf):
            b=name[:-2]
            m={'足D':'足','ひざD':'ひざ','足首D':'足首','足首補助':'足首','ひざ補助':'ひざ','腕捩1':'腕','腕捩2':'腕','腕捩3':'腕','腕捩':'腕',
               '手捩1':'ひじ','手捩2':'ひじ','手捩3':'ひじ','手捩':'ひじ','手首補助':'手首','ひじ補助':'ひじ','ひじ補助2':'ひじ'}
            if b in m: return m[b]+suf
            if b in ('目',): return None
    return name
bones={b.name for b in arm.data.bones}
vg={g.index:g.name for g in o.vertex_groups}
n=len(me.vertices)
W=collections.defaultdict(lambda: np.zeros(n,dtype=np.float32))
for v in me.vertices:
    for g in v.groups:
        nm=vg[g.group]
        if nm in bones:
            c=ctrl_of(nm)
            if c: W[c][v.index]+=g.weight
ok=~np.isnan(tgt[:,0])
def kabsch(P,Q,w):
    w=w/w.sum(); pc=(P*w[:,None]).sum(0); qc=(Q*w[:,None]).sum(0)
    H=((P-pc)*w[:,None]).T@(Q-qc); U,S,Vt=np.linalg.svd(H)
    dd=np.sign(np.linalg.det(Vt.T@U.T)); D=np.diag([1,1,dd])
    R=Vt.T@D@U.T; return R, qc-R@pc
def robust(name):
    w=W[name]
    for thr,mn in ((0.85,12),(0.5,6),(0.25,6)):
        s=ok&(w>=thr)
        if s.sum()>=mn: break
    else: return None
    P,Q,ww=rest[s],tgt[s],w[s]**2
    keep=np.ones(len(P),bool)
    for _ in range(3):
        R,t=kabsch(P[keep],Q[keep],ww[keep])
        r=np.linalg.norm(P@R.T+t-Q,axis=1); med=np.median(r[keep])
        keep=r<=max(3*med,0.005)
    idx=np.nonzero(s)[0][keep]
    return R,t,int(keep.sum()),float(np.sqrt(np.mean(r[keep]**2))),idx,ww[keep]
fits={}
for name in W:
    if name not in bones: continue
    pb=arm.pose.bones[name]
    if any(c.type not in ('IK','LIMIT_ROTATION','DAMPED_TRACK') for c in pb.constraints) or name.startswith(('_dummy_','_shadow_')): continue
    f=robust(name)
    if f: fits[name]=f
# disable mesh evaluation while posing
mods=[(m,True) for m in o.modifiers]
for m,_ in mods: m.show_viewport=False
for pb in arm.pose.bones:
    pb.rotation_mode='QUATERNION'; pb.rotation_quaternion=(1,0,0,0); pb.location=(0,0,0); pb.scale=(1,1,1)
iks=[c for pb in arm.pose.bones for c in pb.constraints if c.type in ('IK','DAMPED_TRACK','LIMIT_ROTATION')]
for c in iks: c.mute=True
vl.update()
# centre translation from 下半身
R,t=fits['下半身'][:2]
h=np.array(arm.data.bones['下半身'].head_local); want=R@h+t
cen=arm.pose.bones['センター']
delta=Vector(want)-arm.pose.bones['下半身'].head
cen.location=arm.data.bones['センター'].matrix_local.to_3x3().inverted()@delta
vl.update()
def depth(b):
    k=0
    while b.parent: b=b.parent; k+=1
    return k
B=arm.data.bones
def nearest_fit(nm):
    # own fit, else fitted ancestor (aiming fixes direction), else closest fitted descendant
    if nm in fits: return fits[nm]
    b=B[nm].parent
    while b:
        if b.name in fits: return fits[b.name]
        b=b.parent
    q=list(B[nm].children)
    while q:
        c=q.pop(0)
        if c.name in fits: return fits[c.name]
        q.extend(c.children)
    return None
def has_fit_below(nm):
    q=list(B[nm].children)
    while q:
        c=q.pop(0)
        if c.name in fits: return True
        q.extend(c.children)
    return False
SKIP=('_dummy_','_shadow_')
movable=[b.name for b in B if not b.name.startswith(SKIP) and (b.name in fits or has_fit_below(b.name))
         and not any(c.type not in ('IK','LIMIT_ROTATION','DAMPED_TRACK') for c in arm.pose.bones[b.name].constraints)
         and b.name not in ('全ての親','センター','グルーブ','腰') and not b.name.startswith(('腕捩','手捩')) and 'ＩＫ' not in b.name]
def hdes(nm):
    f=nearest_fit(nm)
    return None if f is None else Vector((f[0]@np.array(B[nm].head_local)+f[1]).tolist())
def chain_child(nm):
    for c in B[nm].children:
        if c.name in movable and (c.head_local-B[nm].tail_local).length<1e-3: return c.name
    return None
order=sorted(movable,key=lambda nm: depth(B[nm]))
for nm in order:
    pb=arm.pose.bones[nm]; f=nearest_fit(nm)
    Qdes=(Matrix(f[0].tolist())@B[nm].matrix_local.to_3x3()).normalized()
    ch=chain_child(nm)
    for it in range(3):
        vl.update()
        Q=Qdes
        if ch:
            want=(hdes(ch)-pb.head)
            if want.length>1e-6:
                cur=Q.col[1].normalized()   # bone Y axis after fitted rotation
                Q=(cur.rotation_difference(want.normalized()).to_matrix()@Q).normalized()
        Mcur=pb.matrix.to_3x3().normalized()
        corr=(Mcur.inverted()@Q).to_quaternion()
        pb.rotation_quaternion=(pb.rotation_quaternion@corr).normalized()
# refine: fixed-pivot fit about each bone's actual posed head, parents first
def pivot_rot(nm,head):
    f=fits[nm]; idx,ww=f[4],f[5]
    P=rest[idx]-np.array(B[nm].head_local); Q=tgt[idx]-np.array(head)
    w=ww/ww.sum(); H=(P*w[:,None]).T@Q; U,S_,Vt=np.linalg.svd(H)
    dd=np.sign(np.linalg.det(Vt.T@U.T)); return Vt.T@np.diag([1,1,dd])@U.T
def pred_err(nm):
    f=fits[nm]; idx=f[4]; pb=arm.pose.bones[nm]
    M=np.array(pb.matrix@B[nm].matrix_local.inverted())
    pr=rest[idx]@M[:3,:3].T+M[:3,3]
    return float(np.mean(np.linalg.norm(pr-tgt[idx],axis=1)))
def subtree(nm):
    out=[];q=[B[nm]]
    while q:
        b=q.pop(); 
        if b.name in fits: out.append(b.name)
        q.extend(b.children)
    return out
SUB={nm:subtree(nm) for nm in order}
def tree_err(nm):
    tot=0.0;cnt=0
    for c in SUB[nm]:
        f=fits[c]; idx=f[4]; pbc=arm.pose.bones[c]
        M=np.array(pbc.matrix@B[c].matrix_local.inverted())
        pr=rest[idx]@M[:3,:3].T+M[:3,3]
        tot+=float(np.linalg.norm(pr-tgt[idx],axis=1).sum()); cnt+=len(idx)
    return tot/max(cnt,1)
accepted=0
for rnd in range(2):
    for nm in order:
        if nm not in fits: continue
        pb=arm.pose.bones[nm]
        vl.update(); e0=tree_err(nm); q0=pb.rotation_quaternion.copy()
        for it in range(2):
            vl.update()
            Q=(Matrix(pivot_rot(nm,pb.head).tolist())@B[nm].matrix_local.to_3x3()).normalized()
            corr=(pb.matrix.to_3x3().normalized().inverted()@Q).to_quaternion()
            pb.rotation_quaternion=(pb.rotation_quaternion@corr).normalized()
        vl.update()
        if tree_err(nm)>=e0: pb.rotation_quaternion=q0
        else: accepted+=1
print("refinements accepted",accepted)
vl.update()
for m,v in mods: m.show_viewport=v
fitrep={k:(v[2],round(v[3]*1000,1)) for k,v in fits.items()}
np.save(WORK+'/fit_report.npy',np.array([(k,v[0],v[1]) for k,v in fitrep.items()],dtype=object),allow_pickle=True)
print("fitted bones",len(fits),"centre loc",tuple(round(x,4) for x in cen.location))
