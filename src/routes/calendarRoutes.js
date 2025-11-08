import express from 'express';
import { createEvent, updateEvent, deleteEvent, getEvents } from '../services/calendarService.js';

const router = express.Router();

// GET /api/calendar/events - Get events with optional filters (supports Google + Outlook)
// Note: authAndRateLimit middleware (applied at /api level) already extracts token and sets req.token
router.get('/events', async (req, res) => {
  try {
    const { timeMin, timeMax, maxResults, q, type } = req.query;
    const calendarType = type || null; // 'google' | 'outlook' | 'both'
    
    // Determine which token to use based on calendar type:
    // - 'google' or null: token is from Authorization header
    // - 'outlook': token is from Authorization header
    // - 'both': token is from Authorization header, additionalToken is from X-Additional-Token header
    const additionalToken = (calendarType === 'both') ? (req.headers['x-additional-token'] || null) : null;
    const primaryToken = req.token; // Always use token from Authorization header

    const result = await getEvents(primaryToken, {
      timeMin,
      timeMax,
      maxResults: maxResults ? parseInt(maxResults, 10) : undefined,
      q
    }, req.user?.email, calendarType, additionalToken);

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Get events route error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to fetch calendar events'
    });
  }
});

// POST /api/calendar/events - Create event
router.post('/events', async (req, res) => {
  try {
    const { summary, description, startTime, endTime, timeZone, attendees, type } = req.body;
    const calendarType = type || 'google';
    
    if (!summary || !startTime || !endTime) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: summary, startTime, endTime' 
      });
    }

    const result = await createEvent(req.token, {
      summary,
      description,
      startTime,
      endTime,
      timeZone,
      attendees
    }, calendarType);

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Create event route error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to create calendar event'
    });
  }
});

// PUT /api/calendar/events/:eventId - Update event
router.put('/events/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { summary, description, startTime, endTime, timeZone, attendees, type } = req.body;
    const calendarType = type || 'google';

    if (!eventId) {
      return res.status(400).json({
        success: false,
        error: 'Event ID is required'
      });
    }

    const result = await updateEvent(req.token, eventId, {
      summary,
      description,
      startTime,
      endTime,
      timeZone,
      attendees
    }, calendarType);

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Update event route error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update calendar event'
    });
  }
});

// DELETE /api/calendar/events/:eventId - Delete event
router.delete('/events/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { type } = req.query;
    const calendarType = type || 'google';

    if (!eventId) {
      return res.status(400).json({
        success: false,
        error: 'Event ID is required'
      });
    }

    const result = await deleteEvent(req.token, eventId, calendarType);

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Delete event route error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to delete calendar event'
    });
  }
});

export default router;

