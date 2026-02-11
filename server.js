import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const SYSTEM_INSTRUCTION =
  "Tu es un expert technique qui aide un candidat en toute discrétion. Écoute les questions du recruteur. Réponds de manière concise, donne des points clés techniques, des exemples de code si nécessaire, et garde un ton professionnel. Si tu n'as pas entendu la question, reste silencieux.";

if (!GEMINI_API_KEY) {
  console.warn('[warn] GEMINI_API_KEY/GOOGLE_API_KEY is missing. Live sessions will be rejected.');
}

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

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

function extractTranscript(event) {
  const transcripts = extractStringsByKey(event, 'transcript');
  if (transcripts.length > 0) return transcripts.join('\n');

  const inputTranscriptions = extractStringsByKey(event, 'input_transcription');
  return inputTranscriptions.join('\n');
}

function extractSuggestions(event) {
  const directTexts = extractStringsByKey(event, 'text');
  if (directTexts.length > 0) return directTexts.join('\n');

  const outputTexts = extractStringsByKey(event, 'output_text');
  if (outputTexts.length > 0) return outputTexts.join('\n');

  const outputTranscriptionTexts = extractStringsByKey(event, 'output_transcription');
  return outputTranscriptionTexts.join('\n');
}

function sendToClient(clientSocket, payload) {
  if (clientSocket.readyState === WebSocket.OPEN) {
    clientSocket.send(JSON.stringify(payload));
  }
}

async function openLiveSession(clientSocket, callbacks) {
  const baseConfig = {
    responseModalities: [Modality.TEXT],
    systemInstruction: SYSTEM_INSTRUCTION
  };

  // Requested by user: include Google Search tool.
  const withGoogleSearchTool = {
    ...baseConfig,
    tools: [{ googleSearch: {} }]
  };

  try {
    sendToClient(clientSocket, { type: 'status', message: 'Connexion Gemini SDK (tools: googleSearch)...' });
    return await ai.live.connect({
      model: 'gemini-2.0-flash-live-001',
      config: withGoogleSearchTool,
      callbacks
    });
  } catch (error) {
    console.warn('[sdk-connect] tools config failed, fallback without tools:', error?.message);
    sendToClient(clientSocket, {
      type: 'status',
      message: 'Fallback: connexion Gemini SDK sans tools (googleSearch non supporté sur ce modèle/session).'
    });

    return ai.live.connect({
      model: 'gemini-2.0-flash-live-001',
      config: baseConfig,
      callbacks
    });
  }
}

wss.on('connection', async (clientSocket) => {
  if (!ai) {
    sendToClient(clientSocket, { type: 'error', message: 'GEMINI_API_KEY/GOOGLE_API_KEY is not configured on the server.' });
    clientSocket.close(1011, 'Missing server API key');
    return;
  }

  let liveSession = null;

  try {
    const callbacks = {
      onopen: () => {
        sendToClient(clientSocket, { type: 'status', message: 'Connected to Gemini Live (SDK).' });
      },
      onmessage: (message) => {
        const transcript = extractTranscript(message);
        const suggestion = extractSuggestions(message);

        sendToClient(clientSocket, {
          type: 'gemini',
          transcript,
          suggestion,
          raw: message
        });
      },
      onerror: (error) => {
        sendToClient(clientSocket, { type: 'error', message: `Gemini SDK error: ${error.message}` });
      },
      onclose: (event) => {
        sendToClient(clientSocket, {
          type: 'status',
          message: `Gemini disconnected (${event?.code ?? 'n/a'}): ${event?.reason ?? 'session closed'}`
        });
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.close();
        }
      }
    };

    liveSession = await openLiveSession(clientSocket, callbacks);
    sendToClient(clientSocket, { type: 'status', message: 'Session SDK prête, en attente audio...' });
  } catch (error) {
    sendToClient(clientSocket, { type: 'error', message: `Unable to initialize Gemini SDK session: ${error.message}` });
    clientSocket.close(1011, 'Gemini init error');
    return;
  }

  clientSocket.on('message', async (chunk, isBinary) => {
    if (!liveSession) return;

    if (!isBinary) {
      const text = chunk.toString('utf8');
      if (text === 'ping') clientSocket.send('pong');
      return;
    }

    try {
      const base64Audio = Buffer.from(chunk).toString('base64');
      await liveSession.sendRealtimeInput({
        media: {
          mimeType: 'audio/pcm;rate=16000',
          data: base64Audio
        }
      });
    } catch (error) {
      sendToClient(clientSocket, { type: 'error', message: `Audio forwarding error: ${error.message}` });
    }
  });

  const closeSession = async () => {
    if (!liveSession) return;
    try {
      await liveSession.close();
    } catch {
      // ignore teardown errors
    }
    liveSession = null;
  };

  clientSocket.on('close', () => {
    closeSession();
  });

  clientSocket.on('error', () => {
    closeSession();
  });
});

server.listen(PORT, () => {
  console.log(`Interview Copilot server listening on http://localhost:${PORT}`);
});
