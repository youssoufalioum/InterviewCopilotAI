const toggleButton = document.getElementById('toggleAssistant');
const statusLabel = document.getElementById('status');
const transcriptBox = document.getElementById('transcriptBox');
const suggestionBox = document.getElementById('suggestionBox');

let socket;
let audioContext;
let workletNode;
let microphoneStream;
let systemStream;
let mixedNode;
let micSource;
let systemSource;
let sendInterval;
let isRunning = false;

let pendingPCM = new Int16Array(0);

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_MS = 150;

function setStatus(message) {
  statusLabel.textContent = message;
}

function appendLine(target, text) {
  if (!text) return;
  target.textContent += `${text}\n`;
  target.scrollTop = target.scrollHeight;
}

function formatPermissionError(error) {
  if (!error) return "Permission audio refusée.";

  if (error.name === 'NotAllowedError') {
    return "Permission audio refusée. Autorise le micro ET le partage d'écran avec audio système, puis relance l'assistant.";
  }

  if (error.name === 'NotFoundError') {
    return "Aucune source audio trouvée (micro ou audio système indisponible).";
  }

  if (error.name === 'NotReadableError') {
    return "La source audio est déjà utilisée par une autre application.";
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
    const nextSourceOffset = Math.min(
      float32Buffer.length,
      Math.round((resultOffset + 1) * ratio)
    );

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

async function startAssistant() {
  if (isRunning) return;
  isRunning = true;
  toggleButton.textContent = "Arrêter l'Assistant";
  toggleButton.classList.add('is-running');

  try {
    setStatus('Demande des permissions audio...');

    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    // getDisplayMedia est requis pour capturer le son système. Certaines plateformes demandent video: true.
    systemStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => setStatus('Connexion websocket établie.');
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

      if (payload.type === 'gemini') {
        if (payload.transcript) appendLine(transcriptBox, payload.transcript);
        if (payload.suggestion) appendLine(suggestionBox, payload.suggestion);
      }
    };

    audioContext = new AudioContext({ latencyHint: 'interactive' });
    await audioContext.audioWorklet.addModule('./audio-processor.js');

    micSource = audioContext.createMediaStreamSource(microphoneStream);
    systemSource = audioContext.createMediaStreamSource(systemStream);

    const micGain = audioContext.createGain();
    const systemGain = audioContext.createGain();
    mixedNode = audioContext.createGain();

    micGain.gain.value = 1.0;
    systemGain.gain.value = 1.0;

    micSource.connect(micGain);
    systemSource.connect(systemGain);

    micGain.connect(mixedNode);
    systemGain.connect(mixedNode);

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

    setStatus('Assistant actif. Transcription en temps réel...');
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

  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }

  if (microphoneStream) {
    microphoneStream.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
  }

  if (systemStream) {
    systemStream.getTracks().forEach((track) => track.stop());
    systemStream = null;
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }
  socket = null;

  pendingPCM = new Int16Array(0);

  if (!options.keepStatus) {
    setStatus('Assistant arrêté.');
  }
}

toggleButton.addEventListener('click', () => {
  if (isRunning) {
    stopAssistant();
    return;
  }

  startAssistant();
});
