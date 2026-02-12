import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const ASSISTANT_SYSTEM_INSTRUCTION =
  "Tu es un expert technique qui aide un candidat en toute discrétion. Écoute les questions du recruteur. Réponds de manière concise, donne des points clés techniques, des exemples de code si nécessaire, et garde un ton professionnel. Si tu n'as pas entendu la question, reste silencieux.";

const TRANSCRIPT_SYSTEM_INSTRUCTION =
  "Transcris fidèlement l'audio en texte dans la langue d'origine. N'ajoute aucune explication et n'invente rien.";

if (!OPENAI_API_KEY) {
  console.warn('[warn] OPENAI_API_KEY is missing. Realtime sessions will be rejected.');
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function sendToClient(clientSocket, payload) {
  if (clientSocket.readyState === WebSocket.OPEN) {
    clientSocket.send(JSON.stringify(payload));
  }
}


function extractStringsByKey(node, wantedKey, results = []) {
  if (!node || typeof node !== 'object') return results;

  if (Array.isArray(node)) {
    for (const item of node) extractStringsByKey(item, wantedKey, results);
    return results;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key.toLowerCase() === wantedKey && typeof value === 'string' && value.trim()) {
      results.push(value.trim());
    }
    extractStringsByKey(value, wantedKey, results);
  }

  return results;
}

function buildSessionConfig(channel) {
  const isTranscript = channel === 'candidate' || channel === 'interviewer';

  return {
    type: 'session.update',
    session: {
      instructions: isTranscript ? TRANSCRIPT_SYSTEM_INSTRUCTION : ASSISTANT_SYSTEM_INSTRUCTION,
      modalities: ['text'],
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      input_audio_transcription: {
        model: 'gpt-4o-mini-transcribe'
      },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 250,
        silence_duration_ms: 450
      }
    }
  };
}

function parseOpenAIEvent(event, state) {
  // Primary transcription event (candidate/interviewer channels)
  if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
    return { transcript: event.transcript };
  }

  // Fallback: parse nested transcript fields from other event envelopes.
  const nestedTranscripts = extractStringsByKey(event, 'transcript');
  if (nestedTranscripts.length > 0) {
    return { transcript: nestedTranscripts.join('\n') };
  }

  // Assistant text streaming events
  if (event.type === 'response.output_text.delta' && event.delta) {
    state.pendingSuggestion += event.delta;
    return null;
  }

  if (event.type === 'response.output_text.done') {
    const text = state.pendingSuggestion.trim();
    state.pendingSuggestion = '';
    return text ? { suggestion: text } : null;
  }

  // Compatibility with alt response stream event names
  if (event.type === 'response.text.delta' && event.delta) {
    state.pendingSuggestion += event.delta;
    return null;
  }

  if (event.type === 'response.text.done') {
    const text = state.pendingSuggestion.trim();
    state.pendingSuggestion = '';
    return text ? { suggestion: text } : null;
  }

  return null;
}

function connectOpenAIRealtime(clientSocket, channel) {
  const upstream = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  const state = {
    pendingSuggestion: '',
    audioSinceLastCommit: false,
    closed: false
  };

  upstream.on('open', () => {
    upstream.send(JSON.stringify(buildSessionConfig(channel)));
    sendToClient(clientSocket, { type: 'status', message: `Connected to OpenAI Realtime - channel: ${channel}` });
  });

  upstream.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    const parsed = parseOpenAIEvent(event, state);
    if (!parsed) return;

    sendToClient(clientSocket, {
      type: 'ai',
      transcript: parsed.transcript || '',
      suggestion: parsed.suggestion || '',
      raw: event
    });
  });

  upstream.on('close', (code, reasonBuffer) => {
    const reason = reasonBuffer?.toString('utf8') || 'upstream closed';
    if (!state.closed) {
      sendToClient(clientSocket, {
        type: 'status',
        message: `OpenAI Realtime disconnected (${code}): ${reason}`
      });
    }
  });

  upstream.on('error', (error) => {
    sendToClient(clientSocket, { type: 'error', message: `OpenAI Realtime error: ${error.message}` });
  });

  // Commit buffered audio periodically to produce timely transcripts/suggestions.
  const commitTimer = setInterval(() => {
    if (upstream.readyState !== WebSocket.OPEN || !state.audioSinceLastCommit) return;

    upstream.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    upstream.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['text']
        }
      })
    );
    state.audioSinceLastCommit = false;
  }, 900);

  const close = () => {
    state.closed = true;
    clearInterval(commitTimer);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  };

  return {
    sendAudioBase64(base64Audio) {
      if (upstream.readyState !== WebSocket.OPEN) return;
      upstream.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Audio }));
      state.audioSinceLastCommit = true;
    },
    close
  };
}

wss.on('connection', (clientSocket) => {
  if (!openai) {
    sendToClient(clientSocket, { type: 'error', message: 'OPENAI_API_KEY is not configured on the server.' });
    clientSocket.close(1011, 'Missing OPENAI_API_KEY');
    return;
  }

  let channel = 'assistant';
  let bridge = null;

  const ensureBridge = () => {
    if (!bridge) {
      bridge = connectOpenAIRealtime(clientSocket, channel);
      sendToClient(clientSocket, { type: 'status', message: `Session OpenAI prête (${channel}), envoi audio...` });
    }
  };

  const resetBridgeForChannel = (wantedChannel) => {
    channel = wantedChannel;
    if (bridge) {
      bridge.close();
      bridge = null;
    }
    ensureBridge();
  };

  clientSocket.on('message', (chunk, isBinary) => {
    if (!isBinary) {
      const text = chunk.toString('utf8');

      if (text === 'ping') {
        clientSocket.send('pong');
        return;
      }

      try {
        const payload = JSON.parse(text);
        if (payload.type === 'session_config' && typeof payload.channel === 'string') {
          if (['assistant', 'candidate', 'interviewer'].includes(payload.channel)) {
            resetBridgeForChannel(payload.channel);
          }
        }
      } catch {
        // ignore non-json text frames
      }
      return;
    }

    ensureBridge();

    const base64Audio = Buffer.from(chunk).toString('base64');
    bridge.sendAudioBase64(base64Audio);
  });

  clientSocket.on('close', () => {
    if (bridge) bridge.close();
    bridge = null;
  });

  clientSocket.on('error', () => {
    if (bridge) bridge.close();
    bridge = null;
  });
});

server.listen(PORT, () => {
  console.log(`Interview Copilot server listening on http://localhost:${PORT}`);
});
