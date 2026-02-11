# Interview Copilot AI

Application web légère en Vanilla JS + Node.js pour streamer l'audio micro/système vers Gemini Live et afficher transcription + suggestions en temps réel.

## Prérequis

- Node.js 18+
- Une clé API Google AI Studio

## Installation

```bash
npm install
cp .env.example .env
```

Ajoutez votre clé dans `.env` :

```bash
GEMINI_API_KEY=your_api_key_here
```

## Lancement

```bash
export GEMINI_API_KEY=your_api_key_here
npm start
```

Puis ouvrez `http://localhost:3000`.
