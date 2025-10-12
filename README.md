# Scheduler Backend

Backend server for voice-controlled calendar app with MCP support.

## Features
- Express.js REST API
- Google Calendar integration
- MCP (Model Context Protocol) server
- Deployed on GCP Cloud Run (free tier)

## Local Development

### Prerequisites
- Node.js 18+ 
- npm

### Setup
```bash
# Install dependencies
npm install

# Run server
npm start

# Run with auto-reload (Node 18+)
npm run dev
```

Server runs on `http://localhost:8080`

## API Endpoints

### Health Check
```
GET /health
```

Returns server status and timestamp.

## Deployment

Deploy to GCP Cloud Run:
```bash
gcloud run deploy scheduler-backend \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated
```

## Environment Variables
- `PORT` - Server port (default: 8080)

## Project Structure
```
backend/
├── src/
│   └── index.js       # Main server file
├── package.json       # Dependencies
├── .gitignore        # Git ignore rules
└── README.md         # This file
```

