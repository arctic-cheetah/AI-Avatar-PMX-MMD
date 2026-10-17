/** Bridge client: chat input, text preview, moods, and (with bridge --speech) spoken clip IDs. */
const CLIP_ID = /^[0-9a-f]{16}$/;
const MAX_PROMPT = 2000;
const MAX_REPLY = 50000;
export function connectBridge({ catalog, onStart, onFinish, onExpression, onText, onSpeak }) {
  const button = document.querySelector('#bridge-start');
  const status = document.querySelector('#bridge-status');
  const chatBar = document.querySelector('#chat-bar');
  const chatInput = document.querySelector('#chat-input');
  const chatSend = document.querySelector('#chat-send');
  const chatLog = document.querySelector('#chat-log');
  let socket;
  let busy = false;
  let reply = null;

  /** Append a chat bubble (user or Yidhari); returns the message element. */
  function addLine(who) {
    const line = document.createElement('p');
    line.className = `chat-line chat-${who}`;
    const label = document.createElement('span');
    label.className = 'chat-who';
    label.textContent = who === 'you' ? 'You' : 'Yidhari';
    const body = document.createElement('span');
    line.append(label, body);
    chatLog.append(line);
    chatLog.scrollTop = chatLog.scrollHeight;
    return body;
  }

  function setChatEnabled(enabled) {
    chatInput.disabled = !enabled;
    chatSend.disabled = !enabled;
  }

  function startGeneration(prompt) {
    busy = true;
    button.disabled = true;
    setChatEnabled(false);
    socket.send(JSON.stringify(prompt === null ? { type: 'start' } : { type: 'start', prompt }));
    status.textContent = 'Waiting for reply…';
  }
  function connect() {
    socket = new WebSocket('ws://127.0.0.1:8765');
    socket.onopen = () => {
      status.textContent = 'Connected · ready';
      button.disabled = false;
      chatBar.hidden = false;
      setChatEnabled(true);
      chatInput.focus();
    };
    socket.onclose = () => {
      // Do not reset the expression here: while the bridge is down this
      // close/reconnect cycle repeats and would keep forcing neutral.
      busy = false; onFinish(); button.disabled = true; setChatEnabled(false);
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
          case 'start':
            busy = true; button.disabled = true; setChatEnabled(false);
            onStart(); reply = addLine('yidhari'); status.textContent = 'Receiving…'; break;
          case 'expression':
            if (!Object.hasOwn(catalog, event.name) || typeof event.weight !== 'number' || !Number.isFinite(event.weight)) throw new Error('Invalid expression');
            onExpression(event.name, Math.max(0, Math.min(1, event.weight))); break;
          case 'say':
            if (typeof event.text !== 'string') throw new Error('Invalid text');
            onText(event.text);
            if (reply) {
              reply.textContent = (reply.textContent + event.text).slice(-MAX_REPLY);
              chatLog.scrollTop = chatLog.scrollHeight;
            }
            break;
          case 'speak':
            // Only a generated ID crosses the socket; the renderer builds the clip URL itself.
            if (typeof event.id !== 'string' || !CLIP_ID.test(event.id) || !Object.hasOwn(catalog, event.expression) ||
              typeof event.weight !== 'number' || !Number.isFinite(event.weight) || typeof event.text !== 'string') throw new Error('Invalid speak');
            onSpeak({ id: event.id, expression: event.expression, weight: Math.max(0, Math.min(1, event.weight)), text: event.text }); break;
          case 'notice':
            if (typeof event.text !== 'string') throw new Error('Invalid notice');
            status.textContent = event.text; break;
          case 'end':
            busy = false; reply = null; onFinish(); button.disabled = false; setChatEnabled(true);
            status.textContent = 'Complete'; break;
          case 'error':
            if (typeof event.text !== 'string') throw new Error('Invalid error');
            busy = false; reply = null; onFinish(); button.disabled = false; setChatEnabled(true);
            status.textContent = event.text; break;
          default: throw new Error('Unknown event');
        }
      } catch (error) { console.warn('Dropped invalid bridge message', error); }
    };
  }
  button.addEventListener('click', () => {
    if (!busy && socket?.readyState === WebSocket.OPEN) {
      startGeneration(null);
    }
  });
  chatBar.addEventListener('submit', (event) => {
    event.preventDefault();
    const prompt = chatInput.value.trim();
    if (!prompt || busy || socket?.readyState !== WebSocket.OPEN) return;
    addLine('you').textContent = prompt;
    chatInput.value = '';
    startGeneration(prompt);
  });
  connect();
}
