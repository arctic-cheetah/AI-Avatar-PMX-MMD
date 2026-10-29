/** Bridge client: chat input, voice input, text preview, moods, and (with bridge --speech) spoken clip IDs. */
import { VoiceInput, voiceSupported } from './voice-input.js';

const CLIP_ID = /^[0-9a-f]{16}$/;
const MAX_PROMPT = 2000;
const MAX_REPLY = 50000;

/** The one message that starts a reply, whether the prompt was typed or spoken. */
export function startFrame(prompt) {
  return JSON.stringify(prompt === null ? { type: 'start' } : { type: 'start', prompt });
}

/** New chat: the bridge stops any reply, forgets the conversation and answers with a reset event. */
export function resetFrame() {
  return JSON.stringify({ type: 'reset' });
}

export function connectBridge({ catalog, onStart, onFinish, onExpression, onText, onSpeak, onReset }) {
  const button = document.querySelector('#bridge-start');
  const status = document.querySelector('#bridge-status');
  const chatBar = document.querySelector('#chat-bar');
  const chatInput = document.querySelector('#chat-input');
  const chatInputResizer = document.querySelector('#chat-input-resizer');
  const chatSend = document.querySelector('#chat-send');
  const chatMic = document.querySelector('#chat-mic');
  const chatLog = document.querySelector('#chat-log');
  const chatNew = document.querySelector('#chat-new');
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

  function canSend() {
    return !busy && socket?.readyState === WebSocket.OPEN;
  }

  function setChatEnabled(enabled) {
    chatInput.disabled = !enabled;
    chatSend.disabled = !enabled;
    updateMic();
    chatNew.disabled = socket?.readyState !== WebSocket.OPEN;
  }

  /** True after the user drags the composer; typing must not undo that size. */
  let chatInputSized = false;

  /** Grow with the text until the user resizes it. Pass reset after a send. */
  function fitChatInput({ reset = false } = {}) {
    if (reset) chatInputSized = false;
    if (chatInputSized) {
      chatInput.style.overflowY = chatInput.scrollHeight > chatInput.clientHeight + 1 ? 'auto' : 'hidden';
      return;
    }
    chatInput.style.height = 'auto';
    const next = chatInput.scrollHeight;
    const cap = Number.parseFloat(getComputedStyle(chatInput).maxHeight);
    const capped = Number.isFinite(cap) && next > cap;
    chatInput.style.height = `${capped ? cap : next}px`;
    chatInput.style.overflowY = capped ? 'auto' : 'hidden';
  }

  /** Show a prompt as the user's bubble and start a reply; false if the bridge cannot take it now. */
  function sendPrompt(prompt) {
    if (!prompt || !canSend()) return false;
    addLine('you').textContent = prompt;
    chatInput.value = '';
    fitChatInput({ reset: true });
    startGeneration(prompt);
    return true;
  }

  const voice = new VoiceInput({
    onTranscript: (text) => {
      if (!sendPrompt(text)) {
        chatInput.value = text;
        fitChatInput();
        status.textContent = 'Transcript ready · press Send when she is free';
      }
    },
    onStatus: (text) => { status.textContent = text; },
    onState: updateMic,
  });

  function updateMic() {
    const recording = voice.state === 'recording';
    chatMic.disabled = !voiceSupported() || !(recording || (voice.state === 'idle' && canSend()));
    chatMic.setAttribute('aria-pressed', String(recording));
    chatMic.classList.toggle('recording', recording);
    chatMic.textContent = recording ? '■ Stop' : voice.state === 'transcribing' ? '… Transcribing' : '🎤 Talk';
    chatMic.setAttribute('aria-label', recording ? 'Stop recording and send' : 'Talk to Yidhari (start voice input)');
  }

  function startGeneration(prompt) {
    busy = true;
    button.disabled = true;
    setChatEnabled(false);
    socket.send(startFrame(prompt));
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
      busy = false; onFinish(); button.disabled = true; voice.cancel(); setChatEnabled(false);
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
          case 'reset':
            // The bridge has forgotten every turn; clear what the user sees to match.
            busy = false; reply = null; chatLog.replaceChildren(); onReset?.(); onFinish();
            button.disabled = false; setChatEnabled(true);
            status.textContent = 'New chat · ready'; break;
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
  chatNew.addEventListener('click', () => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(resetFrame());
  });
  chatBar.addEventListener('submit', (event) => {
    event.preventDefault();
    sendPrompt(chatInput.value.trim());
  });
  chatInput.addEventListener('input', () => fitChatInput());
  chatInputResizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || chatInput.disabled) return;
    event.preventDefault();
    chatInputSized = true;
    const startY = event.clientY;
    const startHeight = chatInput.getBoundingClientRect().height;
    const maxHeight = Number.parseFloat(getComputedStyle(chatInput).maxHeight);
    chatInputResizer.setPointerCapture(event.pointerId);
    document.body.classList.add('chat-input-resizing');
    function move(next) {
      const limit = Number.isFinite(maxHeight) ? maxHeight : startHeight + 320;
      const height = Math.min(limit, Math.max(38, startHeight + next.clientY - startY));
      chatInput.style.height = `${height}px`;
      chatInput.style.overflowY = chatInput.scrollHeight > chatInput.clientHeight + 1 ? 'auto' : 'hidden';
    }
    function stop() {
      chatInputResizer.removeEventListener('pointermove', move);
      chatInputResizer.removeEventListener('pointerup', stop);
      chatInputResizer.removeEventListener('pointercancel', stop);
      document.body.classList.remove('chat-input-resizing');
    }
    chatInputResizer.addEventListener('pointermove', move);
    chatInputResizer.addEventListener('pointerup', stop);
    chatInputResizer.addEventListener('pointercancel', stop);
  });
  chatInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    sendPrompt(chatInput.value.trim());
  });
  chatMic.title = voiceSupported() ? '' : 'Voice input needs microphone recording support in this browser';
  chatMic.addEventListener('click', () => voice.toggle(canSend()));
  updateMic();
  connect();
}
