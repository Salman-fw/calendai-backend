import express from 'express';
import { createEvent, updateEvent, deleteEvent } from '../services/calendarService.js';

const router = express.Router();

// Middleware to extract access token
function extractToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      success: false, 
      error: 'No authorization token provided' 
    });
  }
  
  req.accessToken = authHeader.substring(7);
  next();
}

// POST /api/calendar/events - Create event
router.post('/events', extractToken, async (req, res) => {
  try {
    const { summary, description, startTime, endTime, timeZone, attendees } = req.body;
    
    if (!summary || !startTime || !endTime) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: summary, startTime, endTime' 
      });
    }

    const result = await createEvent(req.accessToken, {
      summary,
      description,
      startTime,
      endTime,
      timeZone,
      attendees
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Create event route error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// PUT /api/calendar/events/:eventId - Update event
router.put('/events/:eventId', extractToken, async (req, res) => {
  try {
    const { eventId } = req.params;
    const { summary, description, startTime, endTime, timeZone, attendees } = req.body;

    const result = await updateEvent(req.accessToken, eventId, {
      summary,
      description,
      startTime,
      endTime,
      timeZone,
      attendees
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Update event route error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// DELETE /api/calendar/events/:eventId - Delete event
router.delete('/events/:eventId', extractToken, async (req, res) => {
  try {
    const { eventId } = req.params;

    const result = await deleteEvent(req.accessToken, eventId);

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Delete event route error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

export default router;

