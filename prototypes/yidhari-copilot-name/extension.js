'use strict';
const vscode = require('vscode');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const routing = require('./routing');
const { diagnostics, EVENTS } = require('./diagnostics');
const tls = require('node:tls');
const { inspectCertificateTrust } = require('./certificates');
const { buildLaunch } = require('./launch');
let cleanup;

async function activate(context) {
  const output = vscode.window.createOutputChannel('Yidhari Name');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
  status.command = 'yidhariName.status'; status.text = 'Yidhari: off'; status.show();
  context.subscriptions.push(output, status);
  let activePort, activeTransport, activeUpstreamPort, child, stopping = false, queue = Promise.resolve(), rewrites = 0, counts = {};
  const config = () => vscode.workspace.getConfiguration('http');
  const target = vscode.ConfigurationTarget.Global;
  const certDir = path.join(context.globalStorageUri.fsPath, 'proxy-ca');
  const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  function snapshot() {
    return diagnostics({
      running: Boolean(child && child.exitCode === null && child.signalCode === null),
      owned: Boolean(context.globalState.get('routingBackup')),
      proxy: config().get('proxy'), support: config().get('proxySupport'),
      port: activePort, transport: activeTransport, counts: { ...counts, replacements: rewrites }
    });
  }
  function refreshStatus() { status.text = snapshot().status; }
  function showStatus() {
    const current = snapshot();
    output.appendLine(`Extension version: ${context.extension.packageJSON.version}`);
    output.appendLine(current.status);
    if (activeTransport === 'localEndpoint') output.appendLine(`Local endpoint: http://127.0.0.1:${activePort} -> http://127.0.0.1:${activeUpstreamPort}; model URL changes are manual.`);
    output.appendLine(`Certificate setup acknowledged: ${vscode.workspace.getConfiguration('yidhariName').get('certificateTrusted') === true} (not a trust validation)`);
    output.appendLine(`Current proxy process: ${JSON.stringify(counts)}; replacements=${rewrites}`);
    output.appendLine(current.hint);
    status.text = current.status; output.show();
  }
  async function stop() {
    stopping = true;
    try {
      await routing.restore(config(), context.globalState, target);
    } finally {
      const process = child; child = undefined;
      if (process && process.exitCode === null) {
        const exited = new Promise(resolve => process.once('exit', resolve));
        process.kill('SIGTERM');
        let timeout;
        await Promise.race([exited, new Promise(resolve => {
          timeout = setTimeout(() => { process.kill('SIGKILL'); resolve(); }, 2000);
        })]);
        clearTimeout(timeout);
      }
      status.text = 'Yidhari: off'; stopping = false;
    }
  }
  cleanup = () => serial(stop);
  // Recovery happens before commands are registered.
  await routing.restore(config(), context.globalState, target);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('http') || event.affectsConfiguration('yidhariName')) refreshStatus();
  }));

  function checkWorkspace() {
    if (!vscode.workspace.isTrusted) throw Error('A trusted workspace is required.');
    if (vscode.env.remoteName) throw Error('This POC supports local VS Code windows only.');
    if (vscode.workspace.workspaceFolders?.length !== 1) throw Error('Open a single disposable workspace folder first.');
  }
  async function start() {
    checkWorkspace();
    const c = vscode.workspace.getConfiguration('yidhariName');
    if (child) {
      if (activeTransport !== c.get('transport')) throw Error('Disable rewriting before switching transport.');
      return;
    }
    const hosts = c.get('hosts'); const paths = c.get('paths'); const port = c.get('port');
    const transport = c.get('transport'); const upstreamPort = c.get('localUpstreamPort');
    const plan = buildLaunch({ transport, port, upstreamPort, hosts, paths, certDir, addon: path.join(context.extensionPath, 'proxy', 'addon.py') });
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', () => reject(Error('Proxy port is already in use.')));
      probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
    await fs.mkdir(certDir, { recursive: true, mode: 0o700 });
    await fs.chmod(certDir, 0o700);
    const process = spawn(c.get('mitmdumpPath'), plan.args, {
      shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...global.process.env, ...plan.env }
    });
    child = process; activePort = port; activeTransport = transport; activeUpstreamPort = upstreamPort; counts = {}; rewrites = 0;
    // Never forward raw mitmproxy logs: they may contain URLs or credentials.
    process.stderr.resume();
    const lines = readline.createInterface({ input: process.stdout });
    process.once('exit', () => {
      lines.close();
      if (child === process && !stopping) {
        void serial(async () => {
          if (child !== process) return;
          await stop();
          void vscode.window.showErrorMessage('Yidhari proxy stopped. Editor proxy settings restored. In local endpoint mode, restore the model URL to its upstream port.');
        }).catch(() => vscode.window.showErrorMessage('Proxy stopped; remove profile proxy overrides manually.'));
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Proxy startup timed out.')), 10000);
      const fail = () => { clearTimeout(timer); reject(Error('Proxy could not start. Check the mitmdump executable and port.')); };
      process.once('error', fail); process.once('exit', fail);
      lines.on('line', line => {
        if (!line.startsWith('YIDHARI:')) return;
        let event; try { event = JSON.parse(line.slice(8)); } catch { return; }
        if (!EVENTS.has(event.event)) return;
        counts[event.event] = (counts[event.event] || 0) + 1;
        const count = Number.isSafeInteger(event.count) && event.count > 0 ? event.count : 0;
        if (event.event === 'rewritten') rewrites += count;
        output.appendLine(`${event.event}; replacements=${count}; total=${rewrites}`);
        if (event.event === 'ready') {
          clearTimeout(timer); process.removeListener('exit', fail);
          refreshStatus(); resolve();
        } else refreshStatus();
      });
    });
  }
  function command(id, fn) {
    context.subscriptions.push(vscode.commands.registerCommand(id, () => serial(fn).catch(async error => {
      try { await stop(); } catch { output.appendLine('Restore failed: remove profile proxy overrides manually.'); }
      void vscode.window.showErrorMessage(`Yidhari: ${error.message}`);
    })));
  }
  command('yidhariName.prepare', async () => {
    if (vscode.workspace.getConfiguration('yidhariName').get('transport') === 'localEndpoint') {
      void vscode.window.showInformationMessage('Local endpoint mode needs no CA setup. Run Yidhari: Enable Name Rewrite.');
      return;
    }
    await start();
    await vscode.env.openExternal(vscode.Uri.file(certDir));
    showStatus();
    void vscode.window.showInformationMessage(snapshot().routing
      ? 'Proxy certificate directory opened. Routing is already configured.'
      : 'Proxy CA generated. Routing is OFF. Configure certificate trust, then run Yidhari: Enable Name Rewrite.');
  });
  command('yidhariName.enable', async () => {
    checkWorkspace();
    const c = vscode.workspace.getConfiguration('yidhariName');
    if (snapshot().routing && activeTransport === c.get('transport')) { showStatus(); return; }
    if (context.globalState.get('routingBackup')) await routing.restore(config(), context.globalState, target);
    if (c.get('transport') !== 'localEndpoint' && !c.get('certificateTrusted')) throw Error('Prepare the proxy certificate, configure CA trust, then set Certificate Trusted. See README.');
    await start();
    // Catch an exit between readiness and the routing update.
    if (!child || child.exitCode !== null) throw Error('Proxy exited before routing was enabled.');
    if (activeTransport === 'localEndpoint') {
      refreshStatus(); showStatus();
      void vscode.window.showInformationMessage(`Local endpoint ready on port ${activePort}. Change your custom model URL from port ${activeUpstreamPort} to ${activePort}. Restore that URL before stopping the listener.`);
      return;
    }
    await routing.enable(config(), context.globalState, `http://127.0.0.1:${activePort}`, target);
    refreshStatus();
    output.appendLine('Routing enabled. A zero count does not establish compatibility.'); showStatus();
  });
  command('yidhariName.disable', async () => {
    if (activeTransport === 'localEndpoint' && child) void vscode.window.showInformationMessage('Restore your custom model URL to its upstream port before using that model without the listener.');
    await stop();
  });
  command('yidhariName.status', showStatus);
  // Read-only diagnostics must not stop a healthy proxy on a read failure.
  context.subscriptions.push(vscode.commands.registerCommand('yidhariName.checkCertificate', () => serial(async () => {
    try {
      const certPath = path.join(certDir, 'mitmproxy-ca-cert.pem');
      const proxyPEM = await fs.readFile(certPath, 'utf8');
      let extraPEM = '';
      if (global.process.env.NODE_EXTRA_CA_CERTS) {
        try { extraPEM = await fs.readFile(global.process.env.NODE_EXTRA_CA_CERTS, 'utf8'); }
        catch { output.appendLine('Configured extra CA file could not be read.'); }
      }
      const defaults = typeof tls.getCACertificates === 'function' ? tls.getCACertificates('default') : undefined;
      const result = inspectCertificateTrust(proxyPEM, defaults, extraPEM);
      output.appendLine(`Proxy public CA: ${certPath}`);
      output.appendLine(`Proxy CA SHA-256 fingerprint: ${result.fingerprint}`);
      output.appendLine(`Extension host default Node CA list contains proxy CA: ${result.loadedDefaultContainsCA ?? 'unknown (API unavailable)'}`);
      output.appendLine(`Configured extra CA file contains proxy CA: ${result.extraFileContainsCA}`);
      output.appendLine('This checks the extension host only. Separate Agent Host/Chromium trust still requires validation with live request counters.');
    } catch {
      output.appendLine('Certificate check failed. Run Prepare Proxy Certificate and check file permissions; no routing or trust was changed.');
    }
    output.show();
  })));
}
async function deactivate() { if (cleanup) await cleanup(); }
module.exports = { activate, deactivate };
