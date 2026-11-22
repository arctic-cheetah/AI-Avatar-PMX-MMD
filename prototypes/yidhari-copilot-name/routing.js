'use strict';
const KEY = 'routingBackup';
async function restore(config, state, target) {
  const saved = state.get(KEY);
  if (!saved) return;
  for (const [key, item] of Object.entries(saved)) {
    if (config.inspect(key)?.globalValue === item.owned) {
      await config.update(key, item.present ? item.value : undefined, target);
    }
  }
  await state.update(KEY, undefined);
}
async function enable(config, state, url, target) {
  if (state.get(KEY)) throw Error('Disable the current session first.');
  if (config.get('proxy')) throw Error('An existing proxy is configured; proxy chaining is unsupported.');
  const saved = {};
  for (const [key, owned] of Object.entries({ proxy: url, proxySupport: 'on' })) {
    const inspected = config.inspect(key);
    if (inspected?.workspaceFolderValue !== undefined || inspected?.workspaceValue !== undefined) throw Error('Remove folder-level proxy overrides first.');
    const value = inspected?.globalValue;
    saved[key] = { owned, present: value !== undefined, ...(value !== undefined ? { value } : {}) };
  }
  await state.update(KEY, saved);
  try {
    for (const [key, item] of Object.entries(saved)) await config.update(key, item.owned, target);
  } catch (error) {
    await restore(config, state, target);
    throw error;
  }
}
module.exports = { enable, restore };
