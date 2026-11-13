/**
 * Load Ammo.js once for MMDPhysics (#114). ammo.wasm.js is a classic script
 * that defines an `Ammo()` factory and finds ammo.wasm.wasm next to itself.
 * MMDPhysics reads the global `Ammo`, so the resolved library replaces it.
 * See docs/physics.md.
 */

/**
 * @param {{url: string, doc?: Document, global?: object}} options
 *   doc and global default to the page's document and globalThis.
 * @returns {() => Promise<object>} Loads on the first call; later calls share
 *   that load, and a failed load is retried on the next call.
 */
export function createAmmoLoader({ url, doc = globalThis.document, global = globalThis }) {
  let loading = null;
  return function loadAmmo() {
    loading ??= new Promise((resolve, reject) => {
      const script = doc.createElement("script");
      script.src = url;
      script.async = true;
      script.addEventListener("load", () => resolve());
      script.addEventListener("error", () => reject(new Error(`Could not load Ammo.js from ${url}`)));
      doc.head.append(script);
    }).then(async () => {
      if (typeof global.Ammo !== "function") throw new Error("Ammo.js loaded but defined no Ammo() factory");
      const lib = await global.Ammo();
      global.Ammo = lib;
      return lib;
    }).catch((error) => {
      loading = null;
      throw error;
    });
    return loading;
  };
}
