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
const clearTranscriptButton = document.getElementById('clearTranscriptButton');
const aiAnswerButton = document.getElementById('aiAnswerButton');

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
let isRunning = false;
let isTranscriptConnected = false;

let pendingPCM = new Int16Array(0);

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_MS = 150;

const transcriptChannels = {
  candidate: null,
  interviewer: null
};

const lastTranscriptText = {
  candidate: '',
  interviewer: ''
};

function setStatus(message) {
  statusLabel.textContent = message;
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
  if (sourceSampleRate === TARGET_SAMPLE_RATE) {
    return float32Buffer;
  }

  const ratio = sourceSampleRate / TARGET_SAMPLE_RATE;
  const newLength = Math.max(1, Math.round(float32Buffer.length / ratio));
  const result = new Float32Array(newLength);

  // Rééchantillonnage par moyennage de fenêtres: simple et très rapide, idéal pour faible latence.
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

function createChatMessage(role, text) {
  const row = document.createElement('div');
  row.className = `msg-row ${role === 'candidate' ? 'msg-right' : 'msg-left'}`;

  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${role === 'candidate' ? 'candidate' : 'interviewer'}`;
  bubble.textContent = text;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = role === 'candidate' ? 'Candidat' : 'Interviewer';

  row.appendChild(bubble);
  row.appendChild(meta);
  transcriptBox.appendChild(row);
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

function appendTranscriptMessage(role, text) {
  const normalized = (text || '').trim();
  if (!normalized) return;
  if (lastTranscriptText[role] === normalized) return;

  lastTranscriptText[role] = normalized;
  createChatMessage(role, normalized);
}

function sendPendingChunk() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (pendingPCM.length === 0) return;

  const targetSamples = Math.floor((TARGET_SAMPLE_RATE * CHUNK_DURATION_MS) / 1000);

  while (pendingPCM.length >= targetSamples) {
    const chunk = pendingPCM.slice(0, targetSamples);
    pendingPCM = pendingPCM.slice(targetSamples);

    // Envoi binaire brut (PCM16 LE mono 16kHz) pour minimiser l'overhead côté client.
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
    // Ignore autoplay errors; user interaction on the page usually unlocks play.
  }

  videoTracks[0].addEventListener('ended', () => {
    previewVideo.srcObject = null;
    previewPlaceholder.hidden = false;

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
    const message = formatPermissionError(error);
    setStatus(message);
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
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close();
  }
}

function stopChannel(channel) {
  if (!channel) return;

  if (channel.sendInterval) {
    clearInterval(channel.sendInterval);
  }

  if (channel.workletNode) {
    channel.workletNode.port.onmessage = null;
    channel.workletNode.disconnect();
  }

  if (channel.sourceNode) {
    channel.sourceNode.disconnect();
  }

  if (channel.audioContext) {
    channel.audioContext.close();
  }

  closeSocketSafe(channel.socket);
}

function disconnectTranscriptChannels() {
  stopChannel(transcriptChannels.candidate);
  stopChannel(transcriptChannels.interviewer);

  transcriptChannels.candidate = null;
  transcriptChannels.interviewer = null;
  isTranscriptConnected = false;
  connectTranscriptButton.textContent = 'Connect';
}

async function createTranscriptChannel(role, stream) {
  const socketUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  const channel = {
    role,
    socket: new WebSocket(socketUrl),
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

    if ((payload.type === 'ai' || payload.type === 'gemini') && payload.transcript) {
      appendTranscriptMessage(role, payload.transcript);
    }
  };

  await new Promise((resolve, reject) => {
    channel.socket.onopen = () => {
      channel.socket.send(JSON.stringify({ type: 'session_config', channel: role }));
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

  const micOnlyStream = new MediaStream([microphoneStream.getAudioTracks()[0]]);
  const systemAudioStream = new MediaStream(systemStream.getAudioTracks());

  transcriptChannels.candidate = await createTranscriptChannel('candidate', micOnlyStream);
  transcriptChannels.interviewer = await createTranscriptChannel('interviewer', systemAudioStream);

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
      socket.send(JSON.stringify({ type: 'session_config', channel: 'assistant' }));
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
        appendLine(suggestionBox, event.data);
        return;
      }

      if (payload.type === 'status') {
        setStatus(payload.message);
      }

      if (payload.type === 'error') {
        setStatus(payload.message);
      }

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

      // Pipeline faible latence:
      // 1) mixage en mono dans l'AudioWorklet
      // 2) rééchantillonnage rapide vers 16kHz
      // 3) conversion PCM16 puis bufferisation par paquets ~150ms
      const downsampled = downsampleTo16kHz(sourceChunk, audioContext.sampleRate);
      const pcm16 = floatToPCM16(downsampled);
      pendingPCM = concatInt16(pendingPCM, pcm16);
    };

    sendInterval = setInterval(sendPendingChunk, 50);

    setStatus('Assistant actif. Suggestions OpenAI Realtime en temps réel...');
  } catch (error) {
    const userMessage = formatPermissionError(error);
    console.warn('[audio-start-error]', error);
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

  if (!options.keepStatus) {
    setStatus('Assistant arrêté.');
  }
}

async function stopAllStreamsAndTranscriptions() {
  disconnectTranscriptChannels();

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

document.addEventListener('fullscreenchange', syncFullscreenButton);
fullscreenButton.addEventListener('click', () => {
  togglePreviewFullscreen().catch(() => {
    setStatus('Impossible de passer en plein écran.');
  });
});

changeTabButton.addEventListener('click', () => {
  handleChangeTab();
});

connectTranscriptButton.addEventListener('click', async () => {
  if (isTranscriptConnected) {
    disconnectTranscriptChannels();
    setStatus('Transcription déconnectée.');
    return;
  }

  try {
    await connectTranscriptChannels();
  } catch (error) {
    disconnectTranscriptChannels();
    setStatus(formatPermissionError(error));
  }
});

clearTranscriptButton.addEventListener('click', () => {
  transcriptBox.innerHTML = '';
  suggestionBox.textContent = '';
  lastTranscriptText.candidate = '';
  lastTranscriptText.interviewer = '';
  setStatus('Conversation nettoyée.');
});


aiAnswerButton.addEventListener('click', () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("Démarre l'assistant pour demander une réponse IA.");
    return;
  }

  socket.send(JSON.stringify({ type: 'assistant_answer' }));
  setStatus('Demande de réponse IA envoyée...');
});

syncFullscreenButton();

toggleButton.addEventListener('click', async () => {
  if (isRunning) {
    await stopAssistant();

    // Si la transcription n'est pas connectée, on libère complètement les streams.
    if (!isTranscriptConnected) {
      await stopAllStreamsAndTranscriptions();
    }
    return;
  }

  startAssistant();
});
