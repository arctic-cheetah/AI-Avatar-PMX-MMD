'use strict';
const EVENTS = new Set([
  'ready', 'client_connected', 'connect_allowed', 'connect_tunneled',
  'http_request', 'model_request', 'tls_client_failed', 'tls_server_failed',
  'request_error', 'rewritten', 'skipped_route', 'skipped_encoding_or_size',
  'skipped_format', 'no_matching_instruction', 'unsupported_websocket'
]);
function diagnostics({ running, owned, proxy, port, support, counts, transport }) {
  if (transport === 'localEndpoint') {
    return {
      routing: Boolean(running),
      status: running ? `Yidhari: local endpoint ready; ${counts.replacements || 0} replacements` : 'Yidhari: off',
      hint: !running ? 'Enable Name Rewrite to start the local endpoint listener.'
        : counts.rewritten ? 'Local request replacements observed. Verify behavior in a fresh conversation.'
        : 'Set the custom model endpoint URL to this loopback listener. It does not use the editor HTTP proxy. Check model_request, skip and replacement counters.'
    };
  }
  const routing = Boolean(running && owned && proxy === `http://127.0.0.1:${port}` && ['on', 'override', 'fallback'].includes(support));
  const status = !running ? 'Yidhari: off' : !routing ? 'Yidhari: proxy running; routing off' : `Yidhari: routing on; ${counts.replacements || 0} replacements`;
  let hint;
  if (!routing) hint = 'Prepare only starts the proxy. Configure certificate trust, then run Yidhari: Enable Name Rewrite.';
  else if (counts.tls_client_failed) hint = 'Client TLS failed. Check certificate trust in the Agent Host runtime; keep TLS verification enabled.';
  else if (counts.tls_server_failed) hint = 'Upstream TLS failed. Check the upstream certificate chain and trust configuration.';
  else if (counts.rewritten) hint = 'Instruction replacements observed in this proxy process. Use a fresh conversation to verify behavior.';
  else if (!counts.client_connected) hint = 'No client connections observed. Start a fresh Copilot chat and check whether its Agent Host uses this proxy.';
  else if (counts.unsupported_websocket) hint = 'WebSocket traffic observed; this request format is not rewritten by the POC.';
  else if (counts.skipped_encoding_or_size) hint = 'Request skipped because it was compressed, streamed, or too large.';
  else if (counts.skipped_format) hint = 'Request reached the proxy but its payload format is unsupported.';
  else if (counts.no_matching_instruction) hint = 'Eligible JSON received, but no matching identity/style instruction was found.';
  else if (!counts.model_request) hint = 'Connections reached the proxy but no eligible model request was observed. Check configured hosts/paths and the session provider.';
  else hint = 'Model requests observed; waiting for a completed rewrite result. Check request_error and skip counters.';
  return { routing, status, hint };
}
module.exports = { diagnostics, EVENTS };
