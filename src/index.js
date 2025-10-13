import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import transcribeRoutes from './routes/transcribeRoutes.js';
import calendarRoutes from './routes/calendarRoutes.js';
import voiceRoutes from './routes/voiceRoutes.js';
import { requestLogger, errorLogger } from './middleware/logger.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());
app.use(requestLogger);

// Routes
app.use('/api', transcribeRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/voice', voiceRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'scheduler-backend'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Voice Calendar Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      transcribe: 'POST /api/transcribe',
      voice: {
        stream: 'POST /api/voice/stream (SSE: progressive updates - transcription → response)',
        command: 'POST /api/voice/command (returns action preview for confirmation)',
        execute: 'POST /api/voice/execute (executes confirmed action)',
        test: 'POST /api/voice/test (LLM test without auth)'
      },
      calendar: {
        list: 'GET /api/calendar/events?timeMin=&timeMax=&q=&maxResults=',
        create: 'POST /api/calendar/events',
        update: 'PUT /api/calendar/events/:eventId',
        delete: 'DELETE /api/calendar/events/:eventId'
      }
    }
  });
});

// Error handling middleware (must be last)
app.use(errorLogger);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
});

