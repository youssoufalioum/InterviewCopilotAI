const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SYSTEM_INSTRUCTION =
  "Tu es un expert technique qui aide un candidat en toute discrétion. Écoute les questions du recruteur. Réponds de manière concise, donne des points clés techniques, des exemples de code si nécessaire, et garde un ton professionnel. Si tu n'as pas entendu la question, reste silencieux.";

if (!GEMINI_API_KEY) {
  console.warn('[warn] GEMINI_API_KEY is missing. WebSocket proxy will reject new sessions.');
}

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

function extractSuggestions(event) {
  const directTexts = extractStringsByKey(event, 'text');
  if (directTexts.length > 0) return directTexts.join('\n');

  const outputTexts = extractStringsByKey(event, 'output_text');
  if (outputTexts.length > 0) return outputTexts.join('\n');

  const outputTranscriptionTexts = extractStringsByKey(event, 'output_transcription');
  return outputTranscriptionTexts.join('\n');
}

function extractTranscript(event) {
  const transcripts = extractStringsByKey(event, 'transcript');
  if (transcripts.length > 0) return transcripts.join('\n');

  const inputTranscriptions = extractStringsByKey(event, 'input_transcription');
  return inputTranscriptions.join('\n');
}

wss.on('connection', (clientSocket) => {
  if (!GEMINI_API_KEY) {
    clientSocket.send(JSON.stringify({ type: 'error', message: 'GEMINI_API_KEY is not configured on the server.' }));
    clientSocket.close(1011, 'Missing server API key');
    return;
  }

  const geminiUrl =
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';

  const geminiSocket = new WebSocket(`${geminiUrl}?key=${encodeURIComponent(GEMINI_API_KEY)}`);

  let geminiReady = false;

  geminiSocket.on('open', () => {
    geminiReady = true;

    geminiSocket.send(
      JSON.stringify({
        setup: {
          model: 'models/gemini-2.0-flash-live-001',
          generation_config: {
            response_modalities: ['TEXT']
          },
          system_instruction: {
            parts: [{ text: SYSTEM_INSTRUCTION }]
          }
        }
      })
    );

    clientSocket.send(JSON.stringify({ type: 'status', message: 'Connected to Gemini Live.' }));
  });

  geminiSocket.on('message', (rawMessage, isBinary) => {
    if (isBinary) {
      clientSocket.send(rawMessage, { binary: true });
      return;
    }

    const textPayload = rawMessage.toString('utf8');
    let parsed;

    try {
      parsed = JSON.parse(textPayload);
    } catch {
      clientSocket.send(JSON.stringify({ type: 'gemini_raw', payload: textPayload }));
      return;
    }

    const transcript = extractTranscript(parsed);
    const suggestion = extractSuggestions(parsed);

    clientSocket.send(
      JSON.stringify({
        type: 'gemini',
        transcript,
        suggestion,
        raw: parsed
      })
    );
  });

  geminiSocket.on('close', (code, reasonBuffer) => {
    const reason = reasonBuffer?.toString('utf8') || 'Gemini socket closed';
    console.warn(`[gemini-close] code=${code} reason=${reason}`);
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(JSON.stringify({ type: 'status', message: `Gemini disconnected (${code}): ${reason}` }));
      clientSocket.close();
    }
  });

  geminiSocket.on('error', (error) => {
    console.error('[gemini-error]', error);
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(JSON.stringify({ type: 'error', message: `Gemini error: ${error.message}` }));
      clientSocket.close();
    }
  });

  clientSocket.on('message', (chunk, isBinary) => {
    if (!geminiReady || geminiSocket.readyState !== WebSocket.OPEN) return;

    if (!isBinary) {
      const text = chunk.toString('utf8');
      if (text === 'ping') clientSocket.send('pong');
      return;
    }

    const base64Audio = Buffer.from(chunk).toString('base64');

    geminiSocket.send(
      JSON.stringify({
        realtime_input: {
          media_chunks: [
            {
              mime_type: 'audio/pcm;rate=16000',
              data: base64Audio
            }
          ]
        }
      })
    );
  });

  clientSocket.on('close', () => {
    if (geminiSocket.readyState === WebSocket.OPEN || geminiSocket.readyState === WebSocket.CONNECTING) {
      geminiSocket.close();
    }
  });

  clientSocket.on('error', () => {
    if (geminiSocket.readyState === WebSocket.OPEN || geminiSocket.readyState === WebSocket.CONNECTING) {
      geminiSocket.close();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Interview Copilot server listening on http://localhost:${PORT}`);
});
