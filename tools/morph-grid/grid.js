// Morph comparison grid (#99). First set the spec with browser_evaluate:
//   globalThis.__morphGrid = {
//     out: '/abs/path/assets/private/morph-grids/<name>.png',  // gitignored
//     cols: 4,                                     // optional
//     clip: { x: 240, y: 170, width: 400, height: 350 },  // optional: face
//     items: [['label', 'preset-name' | { morph: weight }, weight?], ...],
//   };
// then run this file with browser_run_code_unsafe. Each cell holds the combo
// still (auto-blink off) for 1.3 s, captures the clip, and the cells are laid
// out with their labels. Clips for 1280x800 after setup.js: face (default),
// eyes and brows { x: 230, y: 170, width: 420, height: 230 },
// mouth { x: 330, y: 380, width: 220, height: 130 }.
async (page) => {
  const spec = await page.evaluate(() => globalThis.__morphGrid);
  if (!spec?.out || !Array.isArray(spec.items)) throw new Error('Set globalThis.__morphGrid = { out, items } first.');
  const { out, items, cols = 4, clip = { x: 240, y: 170, width: 400, height: 350 } } = spec;
  const shots = [];
  for (const [label, preset, weight = 1] of items) {
    await page.evaluate(([preset, weight]) => {
      const preview = globalThis.__yidhariPreview;
      const morphs = typeof preset === 'string' ? preview.expressions.catalog[preset]?.morphs : preset;
      if (!morphs) throw new Error(`Unknown preset: ${preset}`);
      preview.hold(Object.fromEntries(Object.entries(morphs).map(([name, value]) => [name, value * weight])));
    }, [preset, weight]);
    await page.waitForTimeout(1300);
    shots.push([label, (await page.screenshot({ clip })).toString('base64')]);
  }
  const escape = (text) => String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const grid = await page.context().newPage();
  await grid.setContent(`<style>body{margin:0;background:#222;color:#fff;font:15px sans-serif;display:grid;align-content:start;grid-template-columns:repeat(${cols},${clip.width}px);gap:4px;width:${cols * (clip.width + 4)}px}figure{margin:0}img{display:block}figcaption{padding:2px 6px}</style>`
    + shots.map(([label, png]) => `<figure><img src="data:image/png;base64,${png}"><figcaption>${escape(label)}</figcaption></figure>`).join(''));
  await grid.screenshot({ path: out, fullPage: true });
  await grid.close();
  return `${shots.length} cells → ${out}`;
}
