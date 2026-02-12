# Interview Copilot AI

Application web légère en Vanilla JS + Node.js pour streamer l'audio micro/système vers OpenAI Realtime et afficher transcription + suggestions en temps réel.

## Prérequis

- Node.js 18+
- Une clé API OpenAI

## Installation

```bash
npm install
cp .env.example .env
```

Ajoutez votre clé dans `.env` :

```bash
OPENAI_API_KEY=your_api_key_here
```

## Lancement

```bash
export OPENAI_API_KEY=your_api_key_here
npm start
```

Puis ouvrez `http://localhost:3000`.

## Stack Realtime

Le backend utilise désormais le SDK officiel `openai` et l'API Realtime (`wss://api.openai.com/v1/realtime`) pour recevoir l'audio PCM16 16kHz, produire des transcriptions et générer des suggestions IA en direct.
