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

Deploy to GCP Cloud Run (example for asia-south1):
```bash
# Authenticate & set project
gcloud auth login
gcloud config set project <PROJECT_ID>

# Deploy
gcloud run deploy calendai-backend \
  --source . \
  --platform managed \
  --region asia-south1 \
  --allow-unauthenticated
```

## Environment Variables
- `PORT` - Server port (default: 8080)
- `LOG_DB_HOST` - Cloud SQL host/IP (required for logging)
- `LOG_DB_PORT` - Cloud SQL port (default 5432)
- `LOG_DB_USER` - Database user
- `LOG_DB_PASSWORD` - Database password
- `LOG_DB_DATABASE` - Database name
- `LOG_DB_SSL` - Set to `true` when using Cloud SQL SSL proxy
- `LOG_LEVEL` - Pino log level (`info` default)

### Logging Database
When the `LOG_DB_*` variables are present the server will:
1. Create the required enums (`calendar_type`, `action_type`)
2. Create two tables:
   - `users`: `id`, `email`, `profile_info`, `created_at`
   - `logs`: `created_at`, `user_id`, `log` JSONB, `calendar_type`, `action_type`
3. Persist structured events for voice/chat/execute flows (payload contains `modality`, user instruction, LLM output, tool call metadata, etc).

Run schema migrations automatically by starting the server once; alternatively run the SQL within `src/services/loggingService.js` manually.

## Project Structure
```
backend/
├── src/
│   └── index.js       # Main server file
├── package.json       # Dependencies
├── .gitignore        # Git ignore rules
└── README.md         # This file
```


