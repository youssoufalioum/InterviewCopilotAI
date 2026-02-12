const toggleButton = document.getElementById('toggleAssistant');
const statusLabel = document.getElementById('status');
const transcriptBox = document.getElementById('transcriptBox');
const suggestionBox = document.getElementById('suggestionBox');
const previewStage = document.getElementById('previewStage');
const previewVideo = document.getElementById('previewVideo');
const previewPlaceholder = document.getElementById('previewPlaceholder');
const fullscreenButton = document.getElementById('fullscreenButton');
const changeTabButton = document.getElementById('changeTabButton');
const connectTranscriptButton = document.getElementById('connectTranscriptButton');
const toggleMicrophoneButton = document.getElementById('toggleMicrophoneButton');
const clearTranscriptButton = document.getElementById('clearTranscriptButton');
const aiAnswerButton = document.getElementById('aiAnswerButton');
const languageSelect = document.getElementById('languageSelect');
const timerPill = document.getElementById('timerPill');

let socket;
let audioContext;
let workletNode;
let microphoneStream;
let systemStream;
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
let isMicrophoneEnabled = true;

let pendingPCM = new Int16Array(0);

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_MS = 150;
const MAX_HISTORY_MESSAGES = 18;

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
    timerPill.textContent = `⏱ ${formatElapsed(Date.now() - startTimestampMs)}`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timerPill.textContent = '⏱ 00:00:00';
}

function appendLine(target, text) {
  if (!text) return;
  target.textContent += `${text}\n`;
  target.scrollTop = target.scrollHeight;
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

  return { row, bubble, meta, text: '', queue: '', timer: null, finalizeTimer: null, role };
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

  const normalized = draft.text.trim();
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
  pushTranscriptHistory(role, normalized);
  syncAssistantContext();
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

    draft.text += draft.queue.slice(0, 1);
    draft.queue = draft.queue.slice(1);
    draft.bubble.textContent = draft.text;
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
  }, 18);
}

function appendTranscriptStream(role, text) {
  const normalized = (text || '').trim();
  if (!normalized) return;

  if (!transcriptDrafts[role]) {
    transcriptDrafts[role] = createTranscriptBubble(role);
  }

  const draft = transcriptDrafts[role];
  const separator = draft.text.length > 0 || draft.queue.length > 0 ? ' ' : '';
  draft.queue += `${separator}${normalized}`;

  if (draft.finalizeTimer) {
    clearTimeout(draft.finalizeTimer);
  }
  draft.finalizeTimer = setTimeout(() => finalizeDraft(role), 900);
  ensureDraftTicker(role);
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

async function ensureMediaStreams() {
  if (!microphoneStream) {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
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
      appendTranscriptStream(role, payload.transcriptDelta);
    }

    if ((payload.type === 'ai' || payload.type === 'gemini') && payload.transcript) {
      appendTranscriptStream(role, payload.transcript);
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
    await ensureMediaStreams();

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
        appendLine(suggestionBox, payload.suggestion);
      }
    };

    audioContext = new AudioContext({ latencyHint: 'interactive' });
    await audioContext.audioWorklet.addModule('./audio-processor.js');

    micSource = audioContext.createMediaStreamSource(microphoneStream);
    systemSource = audioContext.createMediaStreamSource(systemStream);

    micGainNode = audioContext.createGain();
    systemGainNode = audioContext.createGain();
    mixedNode = audioContext.createGain();

    micGainNode.gain.value = 1.0;
    systemGainNode.gain.value = 1.0;

    micSource.connect(micGainNode);
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
    setStatus('Assistant actif. En attente du clic AI Answer.');
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

  if (document.fullscreenElement === previewStage) {
    await document.exitFullscreen();
  }
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
  updateMicButtonLabel();

  if (isTranscriptConnected) {
    await disconnectTranscriptChannels();
    await connectTranscriptChannels();
  }
});

clearTranscriptButton.addEventListener('click', () => {
  transcriptBox.innerHTML = '';
  suggestionBox.textContent = '';
  transcriptHistory.length = 0;
  lastTranscriptText.candidate = '';
  lastTranscriptText.interviewer = '';
  setStatus('Conversation nettoyée.');
});

aiAnswerButton.addEventListener('click', () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("Démarre l'assistant pour demander une réponse IA.");
    return;
  }

  const context = buildTranscriptContext();
  socket.send(JSON.stringify({ type: 'assistant_answer', context, language: languageSelect.value }));
  setStatus('Demande de réponse IA envoyée...');
});

toggleButton.addEventListener('click', async () => {
  if (isRunning) {
    await stopAssistant();
    if (!isTranscriptConnected) await stopAllStreamsAndTranscriptions();
    return;
  }
  await startAssistant();
});

syncFullscreenButton();
updateMicButtonLabel();
