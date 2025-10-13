import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import transcribeRoutes from './routes/transcribeRoutes.js';
import calendarRoutes from './routes/calendarRoutes.js';
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

