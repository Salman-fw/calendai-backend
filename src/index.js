import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import transcribeRoutes from './routes/transcribeRoutes.js';
import calendarRoutes from './routes/calendarRoutes.js';
import voiceRoutes from './routes/voiceRoutes.js';
import { requestLogger, errorLogger } from './middleware/logger.js';
import authAndRateLimit from './middleware/authAndRateLimit.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());
app.use(requestLogger);

// Apply authentication + rate limiting to all /api/* routes
app.use('/api', authAndRateLimit);

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
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  server.close(() => {
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  server.close(() => {
    process.exit(1);
  });
});


