/** Bridge client: chat input, voice input, text preview, moods, and (with bridge --speech) spoken clip IDs. */
import { VoiceInput, voiceSupported } from './voice-input.js';
import { renderMarkdown, plainText } from './markdown.js';
import { ChatHistory } from './chat-history.js';

const CLIP_ID = /^[0-9a-f]{16}$/;
const TURN_ID = /^[0-9a-f]{16}$/;
const MAX_RESET_TURNS = 1000;
const REPLAY_LABEL = '▶ Replay';
const MAX_PROMPT = 2000;
const MAX_REPLY = 50000;
const MAX_SOURCE = 40;
const REPORT_STATUS = new Set(['progress', 'done', 'error']);
const ASK_ID = /^[0-9a-f]{1,32}$/;
const SUMMARY_LENGTH = 80;
const RESTORED_NOTE = "Restored from earlier · Yidhari won't remember these in new replies";
const DAMAGED_NOTE = 'Part of the earlier chat could not be restored';

/** The one message that starts a reply, whether the prompt was typed or spoken. */
export function startFrame(prompt) {
  return JSON.stringify(prompt === null ? { type: 'start' } : { type: 'start', prompt });
}

/** The user's reply to a coding agent's ask (#27); it does not start a chat reply. */
export function answerFrame(id, text) {
  return JSON.stringify({ type: 'answer', id, text });
}

/**
 * New chat: the bridge stops any reply, forgets the conversation and answers with a reset event.
 * turns names the cleared bubbles' spoken turns, whose audio the bridge then deletes (#152).
 */
export function resetFrame(turns = []) {
  const valid = [...new Set(turns.filter((turn) => typeof turn === 'string' && TURN_ID.test(turn)))].slice(-MAX_RESET_TURNS);
  return JSON.stringify(valid.length ? { type: 'reset', turns: valid } : { type: 'reset' });
}

/** The bubble's spoken turn (#152), if the event names a valid one. */
function turnOf(event) {
  return typeof event.turn === 'string' && TURN_ID.test(event.turn) ? { turn: event.turn } : {};
}

/** Page-open greeting (#129): the bridge speaks this fixed phrase without the LLM. */
export function greetFrame({ text, mood, weight }) {
  return JSON.stringify({ type: 'greet', text, mood, weight });
}

/**
 * Validate a coding agent's event (#27): a say line or a full report for the chat log, or a rest mood.
 * @returns {{ kind: 'say', source: string, text: string } |
 *   { kind: 'report', source: string, status: string, text: string } |
 *   { kind: 'mood', source: string, name: string, weight: number }}
 */
export function agentEvent(event, catalog) {
  if (typeof event.source !== 'string') throw new Error('Invalid agent source');
  const source = event.source.slice(0, MAX_SOURCE);
  if (event.kind === 'say') {
    if (typeof event.text !== 'string') throw new Error('Invalid agent text');
    return { kind: 'say', source, text: event.text.slice(0, MAX_REPLY), ...turnOf(event) };
  }
  if (event.kind === 'ask' || event.kind === 'ask-closed') {
    if (typeof event.id !== 'string' || !ASK_ID.test(event.id)) throw new Error('Invalid ask id');
    if (event.kind === 'ask-closed') return { kind: 'ask-closed', source, id: event.id };
    if (typeof event.text !== 'string') throw new Error('Invalid ask');
    return { kind: 'ask', source, id: event.id, text: event.text.slice(0, MAX_REPLY), ...turnOf(event) };
  }
  if (event.kind === 'report') {
    if (typeof event.text !== 'string' || !REPORT_STATUS.has(event.status)) throw new Error('Invalid agent report');
    return { kind: 'report', source, status: event.status, text: event.text.slice(0, MAX_REPLY), ...turnOf(event) };
  }
  if (event.kind === 'mood') {
    if (!Object.hasOwn(catalog, event.name) || typeof event.weight !== 'number' || !Number.isFinite(event.weight)) {
      throw new Error('Invalid agent mood');
    }
    return { kind: 'mood', source, name: event.name, weight: Math.max(0, Math.min(1, event.weight)) };
  }
  throw new Error('Unknown agent event');
}

/**
 * Connect the chat UI to the bridge. history keeps the visible log across a page
 * refresh (#105); win is the window whose pagehide saves a reply still streaming.
 * onActivity fires on every sent chat message, bridge event and voice-input
 * state change, and onAskChange(open) when an agent ask opens or closes; both
 * feed the idle timer (#71).
 */
export function connectBridge({ catalog, onStart, onFinish, onExpression, onText, onSpeak, onFiller, onReset, onAgentSay, onAgentMood, onTurn, greeting = null, onGreeting,
  onActivity, onAskChange, onReplayTurn, history = new ChatHistory(), win = globalThis }) {
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
  /** The streamed reply's Markdown source; the bubble is rendered from it, never read back. */
  let replySource = '';
  /** A coding agent's open question; while set, the chat bar answers it. */
  let pendingAsk = null;
  /**
   * Spoken turns (#152): turn ID → its bubble, its saved entry's id and its replay button.
   * final is set once the turn is known to have no audio left.
   * @type {Map<string, { line: HTMLElement, entryId: string | null, saved: boolean, button: HTMLButtonElement | null, final: boolean }>}
   */
  const turns = new Map();
  let replayEnabled = true;
  /** The streaming reply's turn, and the greeting bubble awaiting its turn. */
  let replyTurn = null;
  let greetingLine = null;
  const chatPlaceholder = chatInput.placeholder;

  function setPendingAsk(ask) {
    const wasOpen = Boolean(pendingAsk);
    pendingAsk = ask;
    if (wasOpen !== Boolean(ask)) onAskChange?.(Boolean(ask));
    chatInput.placeholder = ask ? `Answer ${ask.source}…` : chatPlaceholder;
    chatBar.classList.toggle('answering', Boolean(ask));
  }

  /**
   * Append a chat bubble (user, Yidhari, or Yidhari speaking for an agent); returns the message element.
   * Yidhari's and agents' bubbles hold Markdown (#89); the user's and status lines stay plain text.
   */
  function addLine(who, source = null) {
    const line = document.createElement('div');
    line.className = `chat-line chat-${who}`;
    const label = document.createElement('span');
    label.className = 'chat-who';
    label.textContent = who === 'you' ? 'You' : who === 'tool' ? 'Status' : who === 'agent' ? `Yidhari · for ${source}` : 'Yidhari';
    const body = document.createElement('div');
    body.className = who === 'you' || who === 'tool' ? 'chat-text' : 'chat-text chat-md';
    line.append(label, body);
    chatLog.append(line);
    chatLog.scrollTop = chatLog.scrollHeight;
    return body;
  }

  /** Remember which bubble a spoken turn belongs to. */
  function bindTurn(turn, line, entryId = null, saved = false) {
    if (!turns.has(turn)) turns.set(turn, { line, entryId, saved, button: null, final: false });
  }

  /** Give a bubble its replay button, once. */
  function addReplayButton(turn) {
    const record = turns.get(turn);
    if (!record || record.button) return;
    const button = document.createElement('button');
    button.setAttribute('type', 'button');
    button.className = 'chat-replay';
    button.textContent = REPLAY_LABEL;
    button.setAttribute('aria-label', 'Replay this message');
    button.disabled = !replayEnabled;
    button.addEventListener('click', () => {
      if (!button.disabled) onReplayTurn?.(turn);
    });
    record.button = button;
    record.line.append(button);
  }

  /** A clip of this turn arrived: show the button and save the turn with its entry. */
  function turnSpoke(turn) {
    const record = turns.get(turn);
    if (!record) return;
    addReplayButton(turn);
    if (record.entryId && !record.saved) {
      // By id: another tab may have saved entries since this one was added (#154).
      record.saved = history.setTurn(record.entryId, turn);
    }
  }

  /** The turn has no audio to replay; its button says so and stays disabled. */
  function finalTurn(turn, label) {
    const record = turns.get(turn);
    if (!record?.button) return;
    record.final = true;
    record.button.disabled = true;
    record.button.textContent = label;
    record.button.setAttribute('aria-label', label);
    record.button.classList.add('chat-replay-gone');
  }

  /** Every turn the chat log can still replay, saved or live, oldest first. */
  function chatTurns() {
    return [...history.entries.map((entry) => entry.turn).filter(Boolean), ...turns.keys()];
  }

  /** A report bubble: status and plain first line as the summary, the full Markdown when opened. */
  function addReport({ source, status, text }) {
    const body = addLine('agent', source);
    body.parentElement.classList.add(`chat-report-${status}`);
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const first = plainText(text.trimStart().split('\n', 1)[0]);
    summary.textContent = `Report · ${status}: ${first.length > SUMMARY_LENGTH ? `${first.slice(0, SUMMARY_LENGTH)}…` : first}`;
    const full = document.createElement('div');
    full.className = 'chat-report-body chat-md';
    renderMarkdown(full, text);
    details.append(summary, full);
    body.append(details);
    return body;
  }

  /** Label a reply that stopped before it finished. */
  function markInterrupted(body) {
    body.parentElement.classList.add('chat-interrupted');
    body.parentElement.children[0].textContent += ' · interrupted';
  }

  /** Draw one saved or live log entry and return its line; a restored ask is shown as no longer waiting. */
  function renderEntry(entry, { restored = false } = {}) {
    let body;
    if (entry.who === 'you' || entry.who === 'tool') {
      body = addLine(entry.who);
      body.textContent = entry.text;
    } else if (entry.who === 'yidhari') {
      body = addLine('yidhari');
      renderMarkdown(body, entry.text);
    } else if (entry.kind === 'report') {
      return addReport(entry).parentElement;
    } else {
      body = addLine('agent', entry.source);
      renderMarkdown(body, entry.kind === 'ask' ? `❓ ${entry.text}` : entry.text);
      if (entry.kind === 'ask' && restored) body.parentElement.classList.add('chat-ask-closed');
    }
    if (entry.interrupted) markInterrupted(body);
    return body.parentElement;
  }

  /**
   * Show a live entry and save it for a refresh. A spoken turn is bound to the
   * bubble now, and saved with the entry once its first clip arrives (#152).
   */
  function show(entry, turn = null) {
    const line = renderEntry(entry);
    const saved = history.add(entry) ? history.last() : null;
    if (turn) bindTurn(turn, line, saved?.id ?? null);
  }

  /** A status line about restoring; shown only, never saved. */
  function addNote(text) {
    const body = addLine('tool');
    body.textContent = text;
    body.parentElement.classList.add('chat-restored');
  }

  /** Save the streamed reply once: complete on end, interrupted otherwise. */
  function finishReply({ interrupted = false } = {}) {
    if (reply && replySource) {
      const spoken = replyTurn && turns.get(replyTurn)?.button;
      if (interrupted) markInterrupted(reply);
      history.add({ who: 'yidhari', text: replySource, ...(interrupted ? { interrupted: true } : {}), ...(spoken ? { turn: replyTurn } : {}) });
      // A clip that arrives after the end still saves the turn with this entry.
      const record = replyTurn && turns.get(replyTurn);
      if (record) Object.assign(record, { entryId: history.last()?.id ?? null, saved: Boolean(spoken) });
    }
    reply = null; replySource = ''; replyTurn = null;
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
    onActivity?.();
    show({ who: 'you', text: prompt });
    chatInput.value = '';
    fitChatInput({ reset: true });
    if (pendingAsk) {
      // This message answers the agent's question instead of starting a chat reply.
      socket.send(answerFrame(pendingAsk.id, prompt));
      status.textContent = `Answer sent to ${pendingAsk.source}`;
      setPendingAsk(null);
      return true;
    }
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
    onState: () => { updateMic(); onActivity?.(); },
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
  let greeted = false;
  function connect() {
    socket = new WebSocket('ws://127.0.0.1:8765');
    socket.onopen = () => {
      status.textContent = 'Connected · ready';
      button.disabled = false;
      chatBar.hidden = false;
      setChatEnabled(true);
      chatInput.focus();
      // Page-open greeting (#72): once here, and the gate in main.js keeps it
      // to once per page load, so reconnects below never greet again.
      if (greeting && !greeted) {
        greeted = true;
        const body = addLine('yidhari');
        body.textContent = greeting.text;
        greetingLine = body.parentElement;
        onGreeting?.(greeting);
        socket.send(greetFrame(greeting));
      }
    };
    socket.onclose = () => {
      finishReply({ interrupted: true });
      // Do not reset the expression here: while the bridge is down this
      // close/reconnect cycle repeats and would keep forcing neutral.
      busy = false; setPendingAsk(null); onFinish(); button.disabled = true; voice.cancel(); setChatEnabled(false);
      status.textContent = 'Disconnected · retrying…';
      // onExpression('neutral', 1);
      setTimeout(connect, 2000);
    };
    socket.onerror = () => { status.textContent = 'Bridge unavailable'; };
    socket.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data);
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid event');
        onActivity?.();
        switch (event.type) {
          case 'start':
            busy = true; button.disabled = true; setChatEnabled(false);
            onStart(); reply = addLine('yidhari'); replySource = ''; status.textContent = 'Receiving…';
            replyTurn = turnOf(event).turn ?? null;
            if (replyTurn) bindTurn(replyTurn, reply.parentElement);
            break;
          case 'expression':
            if (!Object.hasOwn(catalog, event.name) || typeof event.weight !== 'number' || !Number.isFinite(event.weight)) throw new Error('Invalid expression');
            onExpression(event.name, Math.max(0, Math.min(1, event.weight))); break;
          case 'say':
            if (typeof event.text !== 'string') throw new Error('Invalid text');
            onText(event.text);
            if (reply) {
              replySource = (replySource + event.text).slice(-MAX_REPLY);
              renderMarkdown(reply, replySource);
              chatLog.scrollTop = chatLog.scrollHeight;
            }
            break;
          case 'filler':
            if (typeof event.id !== 'string' || !CLIP_ID.test(event.id) || !Object.hasOwn(catalog, event.expression) ||
              typeof event.weight !== 'number' || !Number.isFinite(event.weight)) throw new Error('Invalid filler');
            onFiller?.({ id: event.id, expression: event.expression, weight: Math.max(0, Math.min(1, event.weight)) }); break;
          case 'speak':
            // Only a generated ID crosses the socket; the renderer builds the clip URL itself.
            if (typeof event.id !== 'string' || !CLIP_ID.test(event.id) || !Object.hasOwn(catalog, event.expression) ||
              typeof event.weight !== 'number' || !Number.isFinite(event.weight) || typeof event.text !== 'string' ||
              (event.turn !== undefined && (typeof event.turn !== 'string' || !TURN_ID.test(event.turn)))) throw new Error('Invalid speak');
            onSpeak({ id: event.id, expression: event.expression, weight: Math.max(0, Math.min(1, event.weight)), text: event.text, ...turnOf(event) });
            if (event.turn) turnSpoke(event.turn);
            break;
          case 'turn':
            if (event.greeting === true && greetingLine && typeof event.id === 'string' && TURN_ID.test(event.id)) {
              bindTurn(event.id, greetingLine);
              greetingLine = null;
            }
            onTurn?.(); break;
          case 'agent': {
            const agent = agentEvent(event, catalog);
            if (agent.kind === 'say') {
              show({ who: 'agent', kind: 'say', source: agent.source, text: agent.text }, agent.turn);
              onAgentSay?.(busy);
            } else if (agent.kind === 'report') {
              show({ who: 'agent', kind: 'report', source: agent.source, status: agent.status, text: agent.text }, agent.turn);
              onAgentSay?.(busy);
            } else if (agent.kind === 'ask') {
              show({ who: 'agent', kind: 'ask', source: agent.source, text: agent.text }, agent.turn);
              setPendingAsk({ id: agent.id, source: agent.source });
              status.textContent = `${agent.source} is asking · your next message answers`;
              onAgentSay?.(busy);
            } else if (agent.kind === 'ask-closed') {
              if (pendingAsk?.id === agent.id) {
                setPendingAsk(null);
                status.textContent = `${agent.source} stopped waiting for an answer`;
              }
            } else {
              onAgentMood?.(agent.name, agent.weight);
            }
            break;
          }
          case 'notice':
            if (typeof event.text !== 'string') throw new Error('Invalid notice');
            show({ who: 'tool', text: event.text });
            status.textContent = event.text; break;
          case 'end':
            finishReply(); busy = false; onFinish(); button.disabled = false; setChatEnabled(true);
            status.textContent = 'Complete'; break;
          case 'error':
            if (typeof event.text !== 'string') throw new Error('Invalid error');
            finishReply({ interrupted: true }); busy = false; onFinish(); button.disabled = false; setChatEnabled(true);
            status.textContent = event.text; break;
          case 'reset':
            // The bridge has forgotten every turn; clear what the user sees to match.
            busy = false; reply = null; replySource = ''; replyTurn = null; greetingLine = null; turns.clear();
            setPendingAsk(null); chatLog.replaceChildren(); history.clear(); onReset?.(); onFinish();
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
    if (socket?.readyState === WebSocket.OPEN) socket.send(resetFrame(chatTurns()));
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
    // The chat bar may be in the pop-out window; ask its own document.
    const page = chatInput.ownerDocument;
    const maxHeight = Number.parseFloat(page.defaultView.getComputedStyle(chatInput).maxHeight);
    chatInputResizer.setPointerCapture(event.pointerId);
    page.body.classList.add('chat-input-resizing');
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
      page.body.classList.remove('chat-input-resizing');
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
  // #105: rebuild the log saved before a refresh. Display only: no speech,
  // moods, tools or open questions, and the bridge's memory starts fresh.
  const saved = history.load();
  saved.entries.forEach((entry, index) => {
    const line = renderEntry(entry, { restored: true });
    if (entry.turn) {
      bindTurn(entry.turn, line, history.entries[index]?.id ?? null, true);
      addReplayButton(entry.turn);
    }
  });
  if (saved.damaged) addNote(DAMAGED_NOTE);
  if (saved.entries.length) addNote(RESTORED_NOTE);
  win?.addEventListener?.('pagehide', () => finishReply({ interrupted: true }));
  connect();
  return {
    /** Enable the replay buttons only while speech is idle and no reply is streaming. */
    setReplayEnabled(enabled) {
      replayEnabled = Boolean(enabled);
      for (const record of turns.values()) {
        if (record.button && !record.final) record.button.disabled = !replayEnabled;
      }
    },
    /** The bridge pruned this turn's audio. */
    turnGone: (turn) => finalTurn(turn, 'Too old to replay'),
    /** This turn's folder holds no clips. */
    turnEmpty: (turn) => finalTurn(turn, 'No audio to replay'),
  };
}
