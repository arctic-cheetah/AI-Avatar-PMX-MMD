# Live Blender, after fit_pose.py: solve PMX morph weights (0..1) for the facial residual.
# Uses projected gradient descent on a bounded least-squares problem over a curated morph list.
import os, json, numpy as np, bpy
WORK = globals().get('WORK') or os.environ.get('POSE_FIT_DIR', '')
assert WORK, 'Set WORK (a folder for the .npz files) before exec(), or POSE_FIT_DIR.'
CANDIDATES = globals().get('CANDIDATES') or ['ウィンク','ウィンク２','口角上げ','にやり','口下','口上','口右','口左','口横広げ','い','にこり']
# start from a neutral face, so the residual is the whole expression
for _k in bpy.data.objects['伊德海莉_mesh'].data.shape_keys.key_blocks:
    if _k.name != 'Basis': _k.value = 0
_print = print
print = lambda *a, **k: None          # silence eval_fit's table
TOOLS = globals().get('TOOLS') or os.environ.get('POSE_FIT_TOOLS', '')
assert TOOLS, 'Set TOOLS to this folder (tools/pose-fit) before exec(), or POSE_FIT_TOOLS.'
exec(open(os.path.join(TOOLS, 'eval_fit.py')).read())
print = _print
arm = bpy.data.objects['伊德海莉_arm']; kb = o.data.shape_keys.key_blocks
basis = np.empty(len(o.data.vertices) * 3, dtype=np.float32); kb['Basis'].data.foreach_get('co', basis); basis = basis.reshape(-1, 3)
D = []
for nm in CANDIDATES:
    a = np.empty(basis.size, dtype=np.float32); kb[nm].data.foreach_get('co', a); D.append(a.reshape(-1, 3) - basis)
D = np.stack(D)
sel = ok & (np.abs(D).max(axis=(0, 2)) > 1e-5) & (err < 0.05)
pb = arm.pose.bones['頭']
M = np.array(pb.matrix @ arm.data.bones['頭'].matrix_local.inverted())[:3, :3]
res = (tgt[sel] - co[sel]) @ M            # world residual -> head rest frame
A = D[:, sel, :].reshape(len(CANDIDATES), -1).T; b = res.reshape(-1)
w = np.zeros(len(CANDIDATES)); L = np.linalg.norm(A, 2) ** 2
for _ in range(5000):
    w = np.clip(w - A.T @ (A @ w - b) / L, 0, 1)
n = np.sqrt(sel.sum())
print('face rms before %.2f mm, after %.2f mm' % (np.linalg.norm(b) / n * 1000, np.linalg.norm(A @ w - b) / n * 1000))
W = {c: round(float(x), 2) for c, x in zip(CANDIDATES, w) if x > 0.02}
print(W)
json.dump(W, open(WORK + '/morph_fit.json', 'w'), ensure_ascii=False)
for k in kb:
    if k.name != 'Basis': k.value = 0
for c, x in W.items(): kb[c].value = x
