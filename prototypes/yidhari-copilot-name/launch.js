'use strict';
function buildLaunch({ transport, port, upstreamPort, hosts, paths, certDir, addon }) {
  if (!['httpsProxy', 'localEndpoint'].includes(transport)) throw Error('Unknown transport.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid listener port.');
  if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || !/^\/[a-zA-Z0-9/_-]+$/.test(p))) throw Error('Use exact absolute model paths.');
  const args = ['-q', '--listen-host', '127.0.0.1', '--listen-port', String(port)];
  let localPort = '';
  if (transport === 'localEndpoint') {
    if (!Number.isInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65535) throw Error('Invalid local upstream port.');
    if (upstreamPort === port) throw Error('Upstream port must be different from listener port.');
    args.push('--mode', `reverse:http://127.0.0.1:${upstreamPort}`);
    localPort = String(upstreamPort);
  } else {
    if (!Array.isArray(hosts) || !hosts.length || hosts.some(h => typeof h !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(h))) throw Error('Use exact lowercase hostnames.');
    const pattern = '^(?:' + hosts.map(h => h.replaceAll('.', '\\.')).join('|') + ')(?::443)?$';
    args.push('--allow-hosts', pattern);
  }
  args.push('--set', `confdir=${certDir}`, '--set', 'flow_detail=0', '--set', 'stream_large_bodies=4m', '-s', addon);
  return { args, env: { YIDHARI_HOSTS: JSON.stringify(hosts), YIDHARI_PATHS: JSON.stringify(paths), YIDHARI_LOCAL_PORT: localPort } };
}
module.exports = { buildLaunch };
