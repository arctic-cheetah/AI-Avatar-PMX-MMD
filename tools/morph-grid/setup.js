// Morph grid setup (#99). Run with the Playwright MCP tool browser_run_code_unsafe
// (filename: tools/morph-grid/setup.js) while `python3 renderer/serve.py` is up.
// It mocks the bridge socket, so the live avatar keeps its renderer and voice:
// the bridge routes agent speech to the most recently connected page.
async (page) => {
  await page.routeWebSocket(/127\.0\.0\.1:8765/, () => {});
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:8770/renderer/');
  await page.waitForFunction(() => globalThis.__yidhariPreview, null, { timeout: 60000 });
  // A still head keeps every cell framed the same.
  for (const id of ['sway-toggle', 'cursor-gaze-toggle']) {
    if (await page.isChecked('#' + id)) await page.click('#' + id, { force: true });
  }
  await page.mouse.move(440, 400);
  await page.waitForTimeout(1500);
  return page.evaluate(() => document.querySelector('#status, .status')?.textContent);
}
