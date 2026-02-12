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

const ASSISTANT_SYSTEM_INSTRUCTION =
  "Tu es un expert technique qui aide un candidat en toute discrétion. Écoute les questions du recruteur. Réponds de manière concise, donne des points clés techniques, des exemples de code si nécessaire, et garde un ton professionnel. Si tu n'as pas entendu la question, reste silencieux.";

const TRANSCRIPT_SYSTEM_INSTRUCTION =
  "Transcris fidèlement l'audio en texte dans la langue d'origine. N'ajoute aucune explication et n'invente rien.";

if (!GEMINI_API_KEY) {
  console.warn('[warn] GEMINI_API_KEY/GOOGLE_API_KEY is missing. Live sessions will be rejected.');
}

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

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

function extractTranscript(event) {
  const transcriptKeys = ['transcript', 'input_transcription', 'output_transcription'];
  for (const key of transcriptKeys) {
    const values = extractStringsByKey(event, key);
    if (values.length > 0) return values.join('\n');
  }
  return '';
}

function extractSuggestions(event) {
  const suggestionKeys = ['text', 'output_text'];
  for (const key of suggestionKeys) {
    const values = extractStringsByKey(event, key);
    if (values.length > 0) return values.join('\n');
  }
  return '';
}

function getConfigForChannel(channel) {
  if (channel === 'candidate' || channel === 'interviewer') {
    return {
      responseModalities: [Modality.TEXT],
      systemInstruction: TRANSCRIPT_SYSTEM_INSTRUCTION
    };
  }

  return {
    responseModalities: [Modality.TEXT],
    systemInstruction: ASSISTANT_SYSTEM_INSTRUCTION,
    tools: [{ googleSearch: {} }]
  };
}

async function openLiveSession(clientSocket, channel) {
  const config = getConfigForChannel(channel);

  try {
    return await ai.live.connect({
      model: 'gemini-2.0-flash-live-001',
      config,
      callbacks: {
        onopen: () => {
          sendToClient(clientSocket, {
            type: 'status',
            message: `Connected to Gemini Live (SDK) - channel: ${channel}`
          });
        },
        onmessage: (message) => {
          const transcript = extractTranscript(message);
          const suggestion = channel === 'assistant' ? extractSuggestions(message) : '';

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
        }
      }
    });
  } catch (error) {
    // Fallback: if googleSearch is unsupported for this model/session, retry without tools.
    if (channel === 'assistant' && config.tools) {
      return ai.live.connect({
        model: 'gemini-2.0-flash-live-001',
        config: {
          responseModalities: [Modality.TEXT],
          systemInstruction: ASSISTANT_SYSTEM_INSTRUCTION
        },
        callbacks: {
          onopen: () => {
            sendToClient(clientSocket, {
              type: 'status',
              message: 'Connected to Gemini Live (SDK) - assistant fallback sans googleSearch'
            });
          },
          onmessage: (message) => {
            const transcript = extractTranscript(message);
            const suggestion = extractSuggestions(message);
            sendToClient(clientSocket, { type: 'gemini', transcript, suggestion, raw: message });
          },
          onerror: (sdkError) => {
            sendToClient(clientSocket, { type: 'error', message: `Gemini SDK error: ${sdkError.message}` });
          },
          onclose: (event) => {
            sendToClient(clientSocket, {
              type: 'status',
              message: `Gemini disconnected (${event?.code ?? 'n/a'}): ${event?.reason ?? 'session closed'}`
            });
          }
        }
      });
    }

    throw error;
  }
}

wss.on('connection', async (clientSocket) => {
  if (!ai) {
    sendToClient(clientSocket, { type: 'error', message: 'GEMINI_API_KEY/GOOGLE_API_KEY is not configured on the server.' });
    clientSocket.close(1011, 'Missing server API key');
    return;
  }

  let channel = 'assistant';
  let liveSession;

  const closeSession = async () => {
    if (!liveSession) return;
    try {
      await liveSession.close();
    } catch {
      // no-op
    }
    liveSession = null;
  };

  clientSocket.on('message', async (chunk, isBinary) => {
    if (!isBinary) {
      const text = chunk.toString('utf8');

      if (text === 'ping') {
        clientSocket.send('pong');
        return;
      }

      try {
        const payload = JSON.parse(text);

        if (payload.type === 'session_config' && typeof payload.channel === 'string') {
          const wanted = payload.channel;
          if (['assistant', 'candidate', 'interviewer'].includes(wanted) && channel !== wanted) {
            channel = wanted;
            await closeSession();
            liveSession = await openLiveSession(clientSocket, channel);
          }
          return;
        }
      } catch {
        // ignore non-json text frames
      }

      return;
    }

    if (!liveSession) {
      try {
        liveSession = await openLiveSession(clientSocket, channel);
        sendToClient(clientSocket, { type: 'status', message: `Session SDK prête (${channel}), envoi audio...` });
      } catch (error) {
        sendToClient(clientSocket, { type: 'error', message: `Unable to initialize Gemini SDK session: ${error.message}` });
        return;
      }
    }

    try {
      const base64Audio = Buffer.from(chunk).toString('base64');
      await liveSession.sendRealtimeInput({
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: base64Audio
        }
      });
    } catch (error) {
      sendToClient(clientSocket, { type: 'error', message: `Audio forwarding error: ${error.message}` });
    }
  });

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
