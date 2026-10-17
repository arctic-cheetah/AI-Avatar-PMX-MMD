/** Text-only bridge preview. Audio scheduling is a later milestone. */
export function connectBridge({ catalog, onStart, onFinish, onExpression, onText }) {
  const button = document.querySelector('#bridge-start');
  const status = document.querySelector('#bridge-status');
  let socket;
  let busy = false;
  function connect() {
    socket = new WebSocket('ws://127.0.0.1:8765');
    socket.onopen = () => { status.textContent = 'Connected · ready'; button.disabled = false; };
    socket.onclose = () => {
      // Do not reset the expression here: while the bridge is down this
      // close/reconnect cycle repeats and would keep forcing neutral.
      busy = false; onFinish(); button.disabled = true;
      status.textContent = 'Disconnected · retrying…';
      // onExpression('neutral', 1);
      setTimeout(connect, 2000);
    };
    socket.onerror = () => { status.textContent = 'Bridge unavailable'; };
    socket.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data);
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid event');
        switch (event.type) {
          case 'start': busy = true; button.disabled = true; onStart(); status.textContent = 'Receiving…'; break;
          case 'expression':
            if (!Object.hasOwn(catalog, event.name) || typeof event.weight !== 'number' || !Number.isFinite(event.weight)) throw new Error('Invalid expression');
            onExpression(event.name, Math.max(0, Math.min(1, event.weight))); break;
          case 'say':
            if (typeof event.text !== 'string') throw new Error('Invalid text');
            onText(event.text); break;
          case 'end': busy = false; onFinish(); button.disabled = false; status.textContent = 'Complete'; break;
          case 'error':
            if (typeof event.text !== 'string') throw new Error('Invalid error');
            busy = false; onFinish(); button.disabled = false; status.textContent = event.text; break;
          default: throw new Error('Unknown event');
        }
      } catch (error) { console.warn('Dropped invalid bridge message', error); }
    };
  }
  button.addEventListener('click', () => {
    if (!busy && socket?.readyState === WebSocket.OPEN) {
      busy = true; button.disabled = true;
      socket.send(JSON.stringify({ type: 'start' }));
    }
  });
  connect();
}
