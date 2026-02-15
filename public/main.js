const toggleButton = document.getElementById('toggleAssistant');
const statusLabel = document.getElementById('status');
const transcriptBox = document.getElementById('transcriptBox');
const suggestionBox = document.getElementById('suggestionBox');
const previewStage = document.getElementById('previewStage');
const previewVideo = document.getElementById('previewVideo');
const previewPlaceholder = document.getElementById('previewPlaceholder');
const speakerCamVideo = document.getElementById('speakerCamVideo');
const speakerCamPlaceholder = document.getElementById('speakerCamPlaceholder');
const speakerCamToggle = document.getElementById('speakerCamToggle');
const speakerCamIcon = document.getElementById('speakerCamIcon');
const fullscreenButton = document.getElementById('fullscreenButton');
const changeTabButton = document.getElementById('changeTabButton');
const connectTranscriptButton = document.getElementById('connectTranscriptButton');
const toggleMicrophoneButton = document.getElementById('toggleMicrophoneButton');
const clearTranscriptButton = document.getElementById('clearTranscriptButton');
const aiAnswerButton = document.getElementById('aiAnswerButton');
const autoAssistToggle = document.getElementById('autoAssistToggle');
const downloadPdfButton = document.getElementById('downloadPdfButton');
const languageSelect = document.getElementById('languageSelect');
const timerPill = document.getElementById('timerPill');

let socket;
let audioContext;
let workletNode;
let microphoneStream;
let systemStream;
let speakerCamStream;
let isSpeakerCamVisible = false;
let mixedNode;
let micSource;
let systemSource;
let micGainNode;
let systemGainNode;
let sendInterval;
let timerInterval;
let startTimestampMs = 0;

let isRunning = false;
let isTranscriptConnected = false;
let isMicrophoneEnabled = false;
let isAutoAssistEnabled = false;
let lastAutoAssistQuestion = "";
let autoAssistDebounceTimer = null;

let pendingPCM = new Int16Array(0);

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_MS = 150;
const MAX_HISTORY_MESSAGES = 18;

let aiQuestionCounter = 0;
let currentAnswerBody = null;
let pendingQuestionNumber = null;
let pendingQuestionTitle = "";

const transcriptChannels = {
  candidate: null,
  interviewer: null
};

const transcriptDrafts = {
  candidate: null,
  interviewer: null
};

const transcriptHistory = [];

const lastTranscriptText = {
  candidate: '',
  interviewer: ''
};

function setStatus(message) {
  statusLabel.textContent = message;
}

function setAutoAssistEnabled(enabled) {
  isAutoAssistEnabled = Boolean(enabled);
  if (!isAutoAssistEnabled && autoAssistDebounceTimer) {
    clearTimeout(autoAssistDebounceTimer);
    autoAssistDebounceTimer = null;
  }
  if (autoAssistToggle) {
    autoAssistToggle.checked = isAutoAssistEnabled;
    autoAssistToggle.closest('.auto-switch')?.classList.toggle('is-on', isAutoAssistEnabled);
  }
}

function triggerAiAnswer({ manual = false } = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (manual) setStatus("Démarre l'assistant pour demander une réponse IA.");
    return false;
  }

  const context = buildTranscriptContext();
  const language = languageSelect.value;

  if (!hasQuestionInContext(context, language)) {
    if (manual) setStatus('Aucune question détectée dans la transcription.');
    return false;
  }

  const detectedQuestion = extractDetectedQuestion(context, language);
  const displayQuestion = reformulateQuestionTitle(detectedQuestion);
  const signature = `${language}:${displayQuestion.toLowerCase()}`;

  if (!manual && signature && signature === lastAutoAssistQuestion) {
    return false;
  }

  aiQuestionCounter += 1;
  pendingQuestionNumber = aiQuestionCounter;
  pendingQuestionTitle = displayQuestion;
  currentAnswerBody = null;
  lastAutoAssistQuestion = signature;

  socket.send(JSON.stringify({ type: 'assistant_answer', context, language, question: detectedQuestion }));
  setStatus(`Demande de réponse IA envoyée pour Question ${aiQuestionCounter}...`);
  return true;
}

function scheduleAutoAssistCheck(delayMs = 550) {
  if (!isAutoAssistEnabled || !isRunning) return;

  if (autoAssistDebounceTimer) {
    clearTimeout(autoAssistDebounceTimer);
  }

  autoAssistDebounceTimer = setTimeout(() => {
    autoAssistDebounceTimer = null;
    triggerAiAnswer({ manual: false });
  }, delayMs);
}

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function startTimer() {
  if (timerInterval) return;
  startTimestampMs = Date.now();
  timerInterval = setInterval(() => {
    timerPill.innerHTML = `<i class="bi bi-stopwatch" aria-hidden="true"></i> ${formatElapsed(Date.now() - startTimestampMs)}`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timerPill.innerHTML = '<i class="bi bi-stopwatch" aria-hidden="true"></i> 00:00:00';
}

function appendLine(target, text) {
  if (!text) return;
  target.textContent += `${text}\n`;
  target.scrollTop = target.scrollHeight;
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function markdownToHtml(markdown) {
  const source = markdown || '';
  const codeFence = /```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  const parts = [];

  for (const match of source.matchAll(codeFence)) {
    const [full, lang = '', code = ''] = match;
    const startIndex = match.index || 0;
    const textChunk = source.slice(lastIndex, startIndex);
    if (textChunk.trim()) parts.push({ type: 'text', value: textChunk });
    parts.push({ type: 'code', lang: lang.trim(), code: code.trimEnd() });
    lastIndex = startIndex + full.length;
  }

  const tail = source.slice(lastIndex);
  if (tail.trim()) parts.push({ type: 'text', value: tail });

  if (!parts.length) return '<p></p>';

  return parts
    .map((part) => {
      if (part.type === 'code') {
        const langLabel = part.lang ? `<span class="code-lang">${escapeHtml(part.lang)}</span>` : '';
        return `<div class="code-block"><div class="code-toolbar">${langLabel}<button class="copy-code-button" data-code="${encodeURIComponent(part.code)}" type="button">Copier</button></div><pre><code>${escapeHtml(part.code)}</code></pre></div>`;
      }

      let html = escapeHtml(part.value);
      html = html.replace(/^###\s+(.+)$/gm, '<h5>$1</h5>');
      html = html.replace(/^##\s+(.+)$/gm, '<h4>$1</h4>');
      html = html.replace(/^#\s+(.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      html = html.replace(/^-\s+(.+)$/gm, '<li>$1</li>');
      html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
      html = html.replace(/\n\n+/g, '</p><p>');
      html = `<p>${html}</p>`;
      html = html.replace(/<p>\s*<\/p>/g, '');
      html = html.replace(/\n/g, '<br />');
      return html;
    })
    .join('');
}

function extractDetectedQuestion(context, language) {
  const lines = (context || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const prioritized = [
    ...lines.filter((line) => line.toLowerCase().startsWith('interviewer:')),
    ...lines.filter((line) => line.toLowerCase().startsWith('candidate:'))
  ];

  for (let i = prioritized.length - 1; i >= 0; i -= 1) {
    const cleaned = prioritized[i].replace(/^(interviewer|candidate):\s*/i, '').trim();
    if (!cleaned) continue;
    if (cleaned.includes('?') || hasQuestionInContext(cleaned, language)) {
      return cleaned;
    }
  }

  return '';
}

function reformulateQuestionTitle(rawQuestion) {
  const cleaned = (rawQuestion || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  let normalized = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (!/[?.!]$/.test(normalized)) {
    normalized += ' ?';
  }

  return normalized;
}

function createAiQuestionBlock(questionNumber, questionTitle = '') {
  const block = document.createElement('section');
  block.className = 'qa-block';

  const title = document.createElement('h4');
  title.className = 'qa-title';
  title.textContent = questionTitle ? `Question ${questionNumber} : ${questionTitle}` : `Question ${questionNumber}`;

  const body = document.createElement('div');
  body.className = 'qa-body';

  block.appendChild(title);
  block.appendChild(body);
  suggestionBox.appendChild(block);
  suggestionBox.scrollTop = suggestionBox.scrollHeight;

  return body;
}

function appendAiSuggestion(markdownText) {
  if (!markdownText || !markdownText.trim()) return;

  if (!currentAnswerBody) {
    if (pendingQuestionNumber !== null) {
      currentAnswerBody = createAiQuestionBlock(pendingQuestionNumber, pendingQuestionTitle || '');
      pendingQuestionNumber = null;
      pendingQuestionTitle = "";
    } else {
      aiQuestionCounter += 1;
      currentAnswerBody = createAiQuestionBlock(aiQuestionCounter);
    }
  }

  const existingText = currentAnswerBody.dataset.raw || '';
  const merged = `${existingText}${existingText ? '\n\n' : ''}${markdownText.trim()}`;
  currentAnswerBody.dataset.raw = merged;
  currentAnswerBody.innerHTML = markdownToHtml(merged);
  suggestionBox.scrollTop = suggestionBox.scrollHeight;
}

function formatPermissionError(error) {
  if (!error) return 'Permission audio refusée.';
  if (error.name === 'NotAllowedError') {
    return "Permission audio refusée. Autorise le micro ET le partage d'écran avec audio système, puis relance l'assistant.";
  }
  if (error.name === 'NotFoundError') {
    return 'Aucune source audio trouvée (micro ou audio système indisponible).';
  }
  if (error.name === 'NotReadableError') {
    return 'La source audio est déjà utilisée par une autre application.';
  }
  return `Impossible de démarrer: ${error.message}`;
}

function downsampleTo16kHz(float32Buffer, sourceSampleRate) {
  if (sourceSampleRate === TARGET_SAMPLE_RATE) return float32Buffer;

  const ratio = sourceSampleRate / TARGET_SAMPLE_RATE;
  const newLength = Math.max(1, Math.round(float32Buffer.length / ratio));
  const result = new Float32Array(newLength);

  let resultOffset = 0;
  let sourceOffset = 0;

  while (resultOffset < result.length) {
    const nextSourceOffset = Math.min(float32Buffer.length, Math.round((resultOffset + 1) * ratio));

    let total = 0;
    let count = 0;
    for (let i = sourceOffset; i < nextSourceOffset; i += 1) {
      total += float32Buffer[i];
      count += 1;
    }

    result[resultOffset] = count > 0 ? total / count : 0;
    resultOffset += 1;
    sourceOffset = nextSourceOffset;
  }

  return result;
}

function floatToPCM16(float32Buffer) {
  const pcm = new Int16Array(float32Buffer.length);

  for (let i = 0; i < float32Buffer.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Buffer[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return pcm;
}

function concatInt16(existing, incoming) {
  const merged = new Int16Array(existing.length + incoming.length);
  merged.set(existing, 0);
  merged.set(incoming, existing.length);
  return merged;
}

function pushTranscriptHistory(role, text) {
  transcriptHistory.push({ role, text });
  if (transcriptHistory.length > MAX_HISTORY_MESSAGES) {
    transcriptHistory.splice(0, transcriptHistory.length - MAX_HISTORY_MESSAGES);
  }
}

function buildTranscriptContext() {
  return transcriptHistory
    .slice(-MAX_HISTORY_MESSAGES)
    .map((entry) => `${entry.role === 'candidate' ? 'Candidate' : 'Interviewer'}: ${entry.text}`)
    .join('\n');
}


function hasQuestionInContext(context, language) {
  const normalized = (context || '').toLowerCase();
  if (!normalized.trim()) return false;
  if (normalized.includes('?')) return true;

  const cues = {
    fr: new RegExp('\\b(pourquoi|comment|quand|quel|quelle|quels|quelles|est-ce que|peux-tu|pouvez-vous|tu peux|vous pouvez)\\b'),
    en: new RegExp('\\b(why|how|when|what|which|who|where|can you|could you|would you|do you|did you|are you)\\b'),
    es: new RegExp('\\b(por qué|como|cuándo|qué|cuál|puedes|podrías)\\b'),
    de: new RegExp('\\b(warum|wie|wann|was|welche|kannst du|können sie)\\b'),
    it: new RegExp('\\b(perché|come|quando|che|quale|puoi|potresti)\\b'),
    pt: new RegExp('\\b(por que|como|quando|o que|qual|você pode|pode)\\b')
  };

  const re = cues[language] || cues.en;
  return re.test(normalized);
}


function syncAssistantContext() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify({
      type: 'assistant_context',
      context: buildTranscriptContext(),
      language: languageSelect.value
    })
  );
}

function createTranscriptBubble(role) {
  const row = document.createElement('div');
  row.className = `msg-row ${role === 'candidate' ? 'msg-right' : 'msg-left'}`;

  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${role === 'candidate' ? 'candidate' : 'interviewer'}`;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = role === 'candidate' ? 'Candidat (stream...)' : 'Interviewer (stream...)';

  row.appendChild(bubble);
  row.appendChild(meta);
  transcriptBox.appendChild(row);
  transcriptBox.scrollTop = transcriptBox.scrollHeight;

  return {
    row,
    bubble,
    meta,
    text: '',
    queue: '',
    timer: null,
    finalizeTimer: null,
    role
  };
}

function ensureTranscriptDraft(role) {
  if (!transcriptDrafts[role]) {
    transcriptDrafts[role] = createTranscriptBubble(role);
  }
  return transcriptDrafts[role];
}

function scheduleDraftFinalize(role, delayMs = 1400) {
  const draft = transcriptDrafts[role];
  if (!draft) return;

  if (draft.finalizeTimer) {
    clearTimeout(draft.finalizeTimer);
  }

  draft.finalizeTimer = setTimeout(() => finalizeDraft(role), delayMs);
}

function finalizeDraft(role) {
  const draft = transcriptDrafts[role];
  if (!draft) return;

  if (draft.timer) {
    clearInterval(draft.timer);
    draft.timer = null;
  }

  if (draft.finalizeTimer) {
    clearTimeout(draft.finalizeTimer);
    draft.finalizeTimer = null;
  }

  if (draft.queue) {
    draft.text += draft.queue;
    draft.queue = '';
    draft.bubble.textContent = draft.text;
  }

  const normalized = draft.text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    draft.row.remove();
    transcriptDrafts[role] = null;
    return;
  }

  if (lastTranscriptText[role] === normalized) {
    draft.row.remove();
    transcriptDrafts[role] = null;
    return;
  }

  lastTranscriptText[role] = normalized;
  draft.meta.textContent = role === 'candidate' ? 'Candidat' : 'Interviewer';
  draft.text = normalized;
  draft.bubble.textContent = normalized;

  pushTranscriptHistory(role, normalized);
  syncAssistantContext();

  if (role === 'interviewer') {
    scheduleAutoAssistCheck(300);
  }

  transcriptDrafts[role] = null;
}

function ensureDraftTicker(role) {
  const draft = transcriptDrafts[role];
  if (!draft || draft.timer) return;

  draft.timer = setInterval(() => {
    if (!draft.queue.length) {
      clearInterval(draft.timer);
      draft.timer = null;
      return;
    }

    const take = Math.min(3, draft.queue.length);
    draft.text += draft.queue.slice(0, take);
    draft.queue = draft.queue.slice(take);
    draft.bubble.textContent = draft.text;
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
  }, 16);
}

function appendTranscriptDelta(role, deltaText) {
  if (!deltaText) return;

  const draft = ensureTranscriptDraft(role);
  draft.queue += deltaText;
  ensureDraftTicker(role);
  scheduleDraftFinalize(role, 1600);

  if (role === 'interviewer') {
    scheduleAutoAssistCheck(1200);
  }
}

function applyTranscriptCompleted(role, transcriptText) {
  const normalized = (transcriptText || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return;

  const draft = ensureTranscriptDraft(role);

  if (draft.timer) {
    clearInterval(draft.timer);
    draft.timer = null;
  }

  draft.queue = '';
  draft.text = normalized;
  draft.bubble.textContent = normalized;
  draft.meta.textContent = role === 'candidate' ? 'Candidat (finalisation...)' : 'Interviewer (finalisation...)';
  transcriptBox.scrollTop = transcriptBox.scrollHeight;

  scheduleDraftFinalize(role, 220);
}

function clearAllDrafts() {
  finalizeDraft('candidate');
  finalizeDraft('interviewer');
}

function sendPendingChunk() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (pendingPCM.length === 0) return;

  const targetSamples = Math.floor((TARGET_SAMPLE_RATE * CHUNK_DURATION_MS) / 1000);

  while (pendingPCM.length >= targetSamples) {
    const chunk = pendingPCM.slice(0, targetSamples);
    pendingPCM = pendingPCM.slice(targetSamples);
    socket.send(chunk.buffer);
  }
}

async function attachPreviewStream(stream) {
  const videoTracks = stream.getVideoTracks();
  if (videoTracks.length === 0) {
    previewVideo.srcObject = null;
    previewPlaceholder.hidden = false;
    return;
  }

  previewVideo.srcObject = new MediaStream([videoTracks[0]]);
  previewPlaceholder.hidden = true;

  try {
    await previewVideo.play();
  } catch {
    // autoplay may be blocked
  }

  videoTracks[0].addEventListener('ended', () => {
    previewVideo.srcObject = null;
    previewPlaceholder.hidden = false;

    if (isRunning) stopTimer();
    if (isTranscriptConnected) {
      disconnectTranscriptChannels();
      setStatus("Le partage d'écran s'est arrêté.");
    }
  });
}

function clearPreviewStream() {
  previewVideo.pause();
  previewVideo.srcObject = null;
  previewPlaceholder.hidden = false;
}

function updateSpeakerCamUi() {
  if (speakerCamIcon) {
    speakerCamIcon.className = isSpeakerCamVisible ? 'bi bi-eye-slash-fill' : 'bi bi-eye-fill';
  }
  if (speakerCamToggle) {
    speakerCamToggle.classList.toggle('is-on', isSpeakerCamVisible);
    speakerCamToggle.title = isSpeakerCamVisible ? 'Masquer / éteindre Speaker Cam' : 'Afficher / allumer Speaker Cam';
    speakerCamToggle.setAttribute('aria-pressed', isSpeakerCamVisible ? 'true' : 'false');
  }
  if (speakerCamPlaceholder) {
    speakerCamPlaceholder.hidden = isSpeakerCamVisible;
  }
  if (speakerCamVideo) {
    speakerCamVideo.style.visibility = isSpeakerCamVisible ? 'visible' : 'hidden';
  }
}

async function enableSpeakerCam() {
  if (!speakerCamStream) {
    speakerCamStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 24, max: 30 }
      },
      audio: false
    });
  }

  const videoTracks = speakerCamStream.getVideoTracks();
  if (!videoTracks.length) {
    throw new Error("Aucune piste vidéo webcam détectée.");
  }

  speakerCamVideo.srcObject = speakerCamStream;
  try {
    await speakerCamVideo.play();
  } catch {
    // autoplay may be blocked
  }

  isSpeakerCamVisible = true;
  updateSpeakerCamUi();
}

function disableSpeakerCam() {
  if (speakerCamStream) {
    speakerCamStream.getTracks().forEach((track) => track.stop());
    speakerCamStream = null;
  }

  if (speakerCamVideo) {
    speakerCamVideo.pause();
    speakerCamVideo.srcObject = null;
  }

  isSpeakerCamVisible = false;
  updateSpeakerCamUi();
}

async function toggleSpeakerCam() {
  if (isSpeakerCamVisible) {
    disableSpeakerCam();
    return;
  }

  try {
    await enableSpeakerCam();
  } catch (error) {
    setStatus(formatPermissionError(error));
    disableSpeakerCam();
  }
}

async function requestSystemShare() {
  return navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 30, max: 60 }
    },
    audio: {
      channelCount: 2,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });
}

async function ensureMicrophoneStream() {
  if (microphoneStream) return microphoneStream;
  microphoneStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });
  return microphoneStream;
}

async function ensureMediaStreams({ needMicrophone = false } = {}) {
  if (needMicrophone) {
    await ensureMicrophoneStream();
  }

  if (!systemStream) {
    systemStream = await requestSystemShare();
    await attachPreviewStream(systemStream);
  }
}

async function replaceSystemStream(newStream) {
  const previousStream = systemStream;

  if (systemSource) {
    systemSource.disconnect();
    systemSource = null;
  }

  systemStream = newStream;
  await attachPreviewStream(systemStream);

  if (audioContext && systemGainNode) {
    systemSource = audioContext.createMediaStreamSource(systemStream);
    systemSource.connect(systemGainNode);
  }

  if (isTranscriptConnected) {
    disconnectTranscriptChannels();
    await connectTranscriptChannels();
  }

  if (previousStream) {
    previousStream.getTracks().forEach((track) => track.stop());
  }
}

async function handleChangeTab() {
  if (!microphoneStream && !systemStream && !isRunning && !isTranscriptConnected) {
    setStatus("Démarre l'assistant ou Connect avant de changer d'onglet.");
    return;
  }

  try {
    setStatus('Sélectionne un nouvel onglet à partager...');
    const newStream = await requestSystemShare();
    await replaceSystemStream(newStream);
    setStatus('Nouvel onglet partagé.');
  } catch (error) {
    setStatus(formatPermissionError(error));
  }
}

async function togglePreviewFullscreen() {
  if (document.fullscreenElement === previewStage) {
    await document.exitFullscreen();
    return;
  }
  await previewStage.requestFullscreen();
}

function syncFullscreenButton() {
  const isFullscreen = document.fullscreenElement === previewStage;
  fullscreenButton.textContent = isFullscreen ? 'Exit Fullscreen' : 'Fullscreen';
}

function closeSocketSafe(ws) {
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
}

async function stopChannel(channel) {
  if (!channel) return;

  if (channel.sendInterval) clearInterval(channel.sendInterval);
  if (channel.workletNode) {
    channel.workletNode.port.onmessage = null;
    channel.workletNode.disconnect();
  }
  if (channel.sourceNode) channel.sourceNode.disconnect();
  if (channel.audioContext) await channel.audioContext.close();

  closeSocketSafe(channel.socket);
}

async function disconnectTranscriptChannels() {
  await Promise.all([stopChannel(transcriptChannels.candidate), stopChannel(transcriptChannels.interviewer)]);
  transcriptChannels.candidate = null;
  transcriptChannels.interviewer = null;
  isTranscriptConnected = false;
  connectTranscriptButton.textContent = 'Connect';
  clearAllDrafts();
}

function createStreamFromTrack(track) {
  const stream = new MediaStream();
  if (track) stream.addTrack(track);
  return stream;
}

async function createTranscriptChannel(role, stream) {
  const channel = {
    role,
    socket: new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`),
    audioContext: null,
    sourceNode: null,
    workletNode: null,
    pendingPCM: new Int16Array(0),
    sendInterval: null
  };

  channel.socket.binaryType = 'arraybuffer';

  channel.socket.onmessage = (event) => {
    if (typeof event.data !== 'string') return;

    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if ((payload.type === 'ai' || payload.type === 'gemini') && payload.transcriptDelta) {
      appendTranscriptDelta(role, payload.transcriptDelta);
    }

    if ((payload.type === 'ai' || payload.type === 'gemini') && payload.transcript) {
      applyTranscriptCompleted(role, payload.transcript);
    }
  };

  await new Promise((resolve, reject) => {
    channel.socket.onopen = () => {
      channel.socket.send(JSON.stringify({ type: 'session_config', channel: role, language: languageSelect.value }));
      resolve();
    };
    channel.socket.onerror = () => reject(new Error(`WebSocket ${role} indisponible`));
  });

  channel.audioContext = new AudioContext({ latencyHint: 'interactive' });
  await channel.audioContext.audioWorklet.addModule('./audio-processor.js');

  channel.sourceNode = channel.audioContext.createMediaStreamSource(stream);
  channel.workletNode = new AudioWorkletNode(channel.audioContext, 'pcm-mix-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: 'explicit'
  });

  channel.sourceNode.connect(channel.workletNode);

  channel.workletNode.port.onmessage = (event) => {
    const sourceChunk = new Float32Array(event.data);
    const downsampled = downsampleTo16kHz(sourceChunk, channel.audioContext.sampleRate);
    const pcm16 = floatToPCM16(downsampled);
    channel.pendingPCM = concatInt16(channel.pendingPCM, pcm16);
  };

  channel.sendInterval = setInterval(() => {
    if (channel.socket.readyState !== WebSocket.OPEN || channel.pendingPCM.length === 0) return;

    const targetSamples = Math.floor((TARGET_SAMPLE_RATE * CHUNK_DURATION_MS) / 1000);
    while (channel.pendingPCM.length >= targetSamples) {
      const chunk = channel.pendingPCM.slice(0, targetSamples);
      channel.pendingPCM = channel.pendingPCM.slice(targetSamples);
      channel.socket.send(chunk.buffer);
    }
  }, 50);

  return channel;
}

async function connectTranscriptChannels() {
  await ensureMediaStreams();

  const systemTrack = systemStream.getAudioTracks()[0];
  if (!systemTrack) {
    throw new Error("L'onglet partagé ne fournit pas de piste audio. Active 'Partager l'audio de l'onglet'.");
  }

  transcriptChannels.interviewer = await createTranscriptChannel('interviewer', createStreamFromTrack(systemTrack));

  if (isMicrophoneEnabled) {
    const micTrack = microphoneStream?.getAudioTracks?.()[0];
    if (micTrack) {
      transcriptChannels.candidate = await createTranscriptChannel('candidate', createStreamFromTrack(micTrack));
    }
  }

  isTranscriptConnected = true;
  connectTranscriptButton.textContent = 'Disconnect';
  setStatus('Transcription connectée (interviewer + candidat).');
}

async function startAssistant() {
  if (isRunning) return;
  isRunning = true;
  toggleButton.textContent = "Arrêter l'Assistant";
  toggleButton.classList.add('is-running');

  try {
    setStatus('Demande des permissions audio...');
    await ensureMediaStreams({ needMicrophone: isMicrophoneEnabled });

    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'session_config', channel: 'assistant', language: languageSelect.value }));
      syncAssistantContext();
      setStatus('Connexion websocket établie.');
    };

    socket.onerror = () => setStatus('Erreur WebSocket.');
    socket.onclose = () => setStatus('WebSocket fermé.');

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;

      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.type === 'status') setStatus(payload.message);
      if (payload.type === 'error') setStatus(payload.message);
      if ((payload.type === 'ai' || payload.type === 'gemini') && payload.suggestion) {
        appendAiSuggestion(payload.suggestion);
      }
    };

    audioContext = new AudioContext({ latencyHint: 'interactive' });
    await audioContext.audioWorklet.addModule('./audio-processor.js');

    systemSource = audioContext.createMediaStreamSource(systemStream);

    micGainNode = audioContext.createGain();
    systemGainNode = audioContext.createGain();
    mixedNode = audioContext.createGain();

    micGainNode.gain.value = isMicrophoneEnabled ? 1.0 : 0.0;
    systemGainNode.gain.value = 1.0;

    if (isMicrophoneEnabled && microphoneStream) {
      micSource = audioContext.createMediaStreamSource(microphoneStream);
      micSource.connect(micGainNode);
    }

    systemSource.connect(systemGainNode);
    micGainNode.connect(mixedNode);
    systemGainNode.connect(mixedNode);

    workletNode = new AudioWorkletNode(audioContext, 'pcm-mix-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit'
    });

    mixedNode.connect(workletNode);

    workletNode.port.onmessage = (event) => {
      const sourceChunk = new Float32Array(event.data);
      const downsampled = downsampleTo16kHz(sourceChunk, audioContext.sampleRate);
      const pcm16 = floatToPCM16(downsampled);
      pendingPCM = concatInt16(pendingPCM, pcm16);
    };

    sendInterval = setInterval(sendPendingChunk, 50);

    startTimer();

    if (!isTranscriptConnected) {
      try {
        await connectTranscriptChannels();
      } catch (error) {
        setStatus(`Assistant actif, mais transcription non connectée: ${formatPermissionError(error)}`);
      }
    }

    if (!isTranscriptConnected) {
      setStatus('Assistant actif. En attente du clic AI Answer.');
    }
  } catch (error) {
    const userMessage = formatPermissionError(error);
    setStatus(userMessage);
    appendLine(suggestionBox, `⚠️ ${userMessage}`);
    await stopAssistant({ keepStatus: true });
  }
}

async function stopAssistant(options = {}) {
  if (!isRunning) return;
  isRunning = false;

  toggleButton.textContent = "Démarrer l'Assistant";
  toggleButton.classList.remove('is-running');

  stopTimer();

  if (sendInterval) {
    clearInterval(sendInterval);
    sendInterval = null;
  }

  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }

  if (mixedNode) {
    mixedNode.disconnect();
    mixedNode = null;
  }

  if (micSource) {
    micSource.disconnect();
    micSource = null;
  }

  if (systemSource) {
    systemSource.disconnect();
    systemSource = null;
  }

  if (micGainNode) {
    micGainNode.disconnect();
    micGainNode = null;
  }

  if (systemGainNode) {
    systemGainNode.disconnect();
    systemGainNode = null;
  }

  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }

  closeSocketSafe(socket);
  socket = null;
  pendingPCM = new Int16Array(0);

  if (!options.keepStatus) setStatus('Assistant arrêté.');
}

async function stopAllStreamsAndTranscriptions() {
  await disconnectTranscriptChannels();

  if (microphoneStream) {
    microphoneStream.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
  }

  if (systemStream) {
    systemStream.getTracks().forEach((track) => track.stop());
    systemStream = null;
  }

  clearPreviewStream();
  disableSpeakerCam();

  isMicrophoneEnabled = false;
  updateMicButtonLabel();
  if (autoAssistDebounceTimer) {
    clearTimeout(autoAssistDebounceTimer);
    autoAssistDebounceTimer = null;
  }

  if (document.fullscreenElement === previewStage) {
    await document.exitFullscreen();
  }
}



function exportSuggestionsToPdf() {
  const qaBlocks = Array.from(suggestionBox.querySelectorAll('.qa-block'));
  if (!qaBlocks.length) {
    setStatus('Aucune question/réponse à exporter.');
    return;
  }

  const printableContent = qaBlocks.map((block) => block.outerHTML).join('');
  const printWindow = window.open('', '_blank', 'width=900,height=700');

  if (!printWindow) {
    setStatus("Impossible d'ouvrir la fenêtre d'impression.");
    return;
  }

  printWindow.document.write(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<title>Interview Copilot - Export PDF</title>
<style>
body { font-family: Inter, Arial, sans-serif; margin: 24px; color: #0f172a; }
h1 { margin: 0 0 16px; font-size: 22px; }
.qa-block { border: 1px solid #d6dfec; border-radius: 10px; background: #f8fbff; padding: 12px; margin-bottom: 12px; page-break-inside: avoid; }
.qa-title { margin: 0 0 8px; color: #1e3a8a; font-size: 16px; }
.qa-body p { margin: 6px 0; }
.qa-body ul { margin: 6px 0 6px 20px; }
.code-block { border: 1px solid #1f2937; border-radius: 8px; overflow: hidden; margin: 10px 0; }
.code-toolbar, .copy-code-button { display: none !important; }
.qa-body pre { margin: 0; padding: 10px; background: #0f172a; color: #f8fafc; overflow-x: auto; }
@media print { body { margin: 12mm; } }
</style>
</head>
<body>
<h1>Interview Copilot — Questions / Réponses</h1>
${printableContent}
</body>
</html>`);

  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}

function updateMicButtonLabel() {
  toggleMicrophoneButton.textContent = isMicrophoneEnabled ? 'Désactiver micro' : 'Activer micro';
}

document.addEventListener('fullscreenchange', syncFullscreenButton);

fullscreenButton.addEventListener('click', () => {
  togglePreviewFullscreen().catch(() => setStatus('Impossible de passer en plein écran.'));
});

changeTabButton.addEventListener('click', () => {
  handleChangeTab();
});

speakerCamToggle.addEventListener('click', () => {
  toggleSpeakerCam();
});

languageSelect.addEventListener('change', async () => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'session_config', channel: 'assistant', language: languageSelect.value }));
    syncAssistantContext();
  }

  if (isTranscriptConnected) {
    await disconnectTranscriptChannels();
    await connectTranscriptChannels();
  }

  setStatus(`Langue de l'interview: ${languageSelect.options[languageSelect.selectedIndex].text}`);
});

connectTranscriptButton.addEventListener('click', async () => {
  if (isTranscriptConnected) {
    await disconnectTranscriptChannels();
    setStatus('Transcription déconnectée.');
    return;
  }

  try {
    await connectTranscriptChannels();
  } catch (error) {
    await disconnectTranscriptChannels();
    setStatus(formatPermissionError(error));
  }
});

toggleMicrophoneButton.addEventListener('click', async () => {
  isMicrophoneEnabled = !isMicrophoneEnabled;

  if (isMicrophoneEnabled) {
    try {
      await ensureMicrophoneStream();
    } catch (error) {
      isMicrophoneEnabled = false;
      updateMicButtonLabel();
      setStatus(formatPermissionError(error));
      return;
    }
  }

  updateMicButtonLabel();

  if (isRunning && micGainNode) {
    micGainNode.gain.value = isMicrophoneEnabled ? 1.0 : 0.0;

    if (isMicrophoneEnabled && !micSource && microphoneStream && audioContext) {
      micSource = audioContext.createMediaStreamSource(microphoneStream);
      micSource.connect(micGainNode);
    }
  }

  if (isTranscriptConnected) {
    await disconnectTranscriptChannels();
    await connectTranscriptChannels();
  }
});

autoAssistToggle.addEventListener('change', () => {
  setAutoAssistEnabled(autoAssistToggle.checked);
});

downloadPdfButton.addEventListener('click', exportSuggestionsToPdf);

clearTranscriptButton.addEventListener('click', () => {
  transcriptBox.innerHTML = '';
  suggestionBox.textContent = '';
  aiQuestionCounter = 0;
  currentAnswerBody = null;
  pendingQuestionNumber = null;
  pendingQuestionTitle = "";
  transcriptHistory.length = 0;
  lastTranscriptText.candidate = '';
  lastTranscriptText.interviewer = '';
  lastAutoAssistQuestion = '';
  setStatus('Conversation nettoyée.');
});

aiAnswerButton.addEventListener('click', () => {
  triggerAiAnswer({ manual: true });
});




document.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (!target.classList.contains('copy-code-button')) return;

  const encoded = target.dataset.code || '';
  const code = decodeURIComponent(encoded);

  try {
    await navigator.clipboard.writeText(code);
    const original = target.textContent;
    target.textContent = 'Copié !';
    setTimeout(() => {
      target.textContent = original || 'Copier';
    }, 1200);
  } catch {
    setStatus('Impossible de copier le code automatiquement.');
  }
});

toggleButton.addEventListener('click', async () => {
  if (isRunning) {
    await stopAssistant();
    await stopAllStreamsAndTranscriptions();
    setAutoAssistEnabled(false);
updateSpeakerCamUi();
    lastAutoAssistQuestion = '';
    return;
  }
  await startAssistant();
});

syncFullscreenButton();
updateMicButtonLabel();
setAutoAssistEnabled(false);
updateSpeakerCamUi();
