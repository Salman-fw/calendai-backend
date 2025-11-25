import express from 'express';
import { createEvent, updateEvent, deleteEvent, getEvents, createTask, updateTask, deleteTask } from '../services/calendarService.js';
import { recordInteractionLog } from '../utils/interactionLogger.js';

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

    // Normalize dates to ensure they have timezone info (RFC3339 format required by Google Calendar API)
    // If dates are missing timezone, assume they're in UTC and append 'Z'
    let normalizedTimeMin = timeMin;
    let normalizedTimeMax = timeMax;
    
    if (timeMin) {
      // Check if date already has timezone: ends with Z, or has offset like +05:00, -08:00, +0500
      const hasTimezone = timeMin.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(timeMin);
      if (!hasTimezone) {
        try {
          // Parse as UTC and convert to ISO string (assumes input is UTC if no timezone specified)
          const date = new Date(timeMin + (timeMin.includes('T') ? 'Z' : ''));
          if (!isNaN(date.getTime())) {
            normalizedTimeMin = date.toISOString();
          }
        } catch (e) {
          console.warn('Failed to normalize timeMin:', timeMin, e.message);
          // Keep original if parsing fails - let the API handle the error
        }
      }
    }
    
    if (timeMax) {
      // Check if date already has timezone: ends with Z, or has offset like +05:00, -08:00, +0500
      const hasTimezone = timeMax.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(timeMax);
      if (!hasTimezone) {
        try {
          // Parse as UTC and convert to ISO string (assumes input is UTC if no timezone specified)
          const date = new Date(timeMax + (timeMax.includes('T') ? 'Z' : ''));
          if (!isNaN(date.getTime())) {
            normalizedTimeMax = date.toISOString();
          }
        } catch (e) {
          console.warn('Failed to normalize timeMax:', timeMax, e.message);
          // Keep original if parsing fails - let the API handle the error
        }
      }
    }

    const result = await getEvents(primaryToken, {
      timeMin: normalizedTimeMin,
      timeMax: normalizedTimeMax,
      maxResults: maxResults ? parseInt(maxResults, 10) : undefined,
      q
    }, req.user?.email, calendarType, additionalToken);

    if (result.success) {
      await recordInteractionLog(req, {
        actionType: 'unified_calendar',
        calendarType: type,
        payload: {
          metadata: {
            endpoint: 'calendar_events_list',
            request_id: req.requestId
          },
          parameters: {
            timeMin: normalizedTimeMin,
            timeMax: normalizedTimeMax,
            q
          },
          result_summary: {
            count: Array.isArray(result.events) ? result.events.length : 0
          }
        }
      });
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
      await recordInteractionLog(req, {
        actionType: 'create',
        calendarType: type,
        payload: {
          metadata: {
            endpoint: 'calendar_events_create',
            request_id: req.requestId
          },
          request_body: req.body,
          result: result.event ? { id: result.event.id } : result
        }
      });
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
      await recordInteractionLog(req, {
        actionType: 'update',
        calendarType: type,
        payload: {
          metadata: {
            endpoint: 'calendar_events_update',
            request_id: req.requestId
          },
          request_body: { eventId, ...req.body },
          result: result.event ? { id: result.event.id } : result
        }
      });
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
      await recordInteractionLog(req, {
        actionType: 'delete',
        calendarType: type,
        payload: {
          metadata: {
            endpoint: 'calendar_events_delete',
            request_id: req.requestId
          },
          request_params: { eventId },
          result
        }
      });
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

// POST /api/calendar/tasks - Create a new task
router.post('/tasks', async (req, res) => {
  try {
    const { type } = req.query;
    const calendarType = type || 'google'; // Default to Google
    
    if (!req.token) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const result = await createTask(req.token, req.body, calendarType);
    
    if (result.success) {
      await recordInteractionLog(req, {
        actionType: 'create',
        calendarType: type,
        payload: {
          metadata: {
            endpoint: 'calendar_tasks_create',
            request_id: req.requestId
          },
          request_body: req.body,
          result: result.task ? { id: result.task.id } : result
        }
      });
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Create task route error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to create task'
    });
  }
});

// PUT /api/calendar/tasks/:taskId - Update a task
router.put('/tasks/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { type } = req.query;
    const calendarType = type || 'google'; // Default to Google
    
    if (!req.token) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    if (!taskId) {
      return res.status(400).json({ success: false, error: 'Task ID is required' });
    }

    const result = await updateTask(req.token, taskId, req.body, calendarType);
    
    if (result.success) {
      await recordInteractionLog(req, {
        actionType: 'update',
        calendarType: type,
        payload: {
          metadata: {
            endpoint: 'calendar_tasks_update',
            request_id: req.requestId
          },
          request_body: { taskId, ...req.body },
          result: result.task ? { id: result.task.id } : result
        }
      });
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Update task route error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update task'
    });
  }
});

// DELETE /api/calendar/tasks/:taskId - Delete a task
router.delete('/tasks/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { type } = req.query;
    const calendarType = type || 'google'; // Default to Google
    
    if (!req.token) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    if (!taskId) {
      return res.status(400).json({ success: false, error: 'Task ID is required' });
    }

    const result = await deleteTask(req.token, taskId, calendarType);
    
    if (result.success) {
      await recordInteractionLog(req, {
        actionType: 'delete',
        calendarType: type,
        payload: {
          metadata: {
            endpoint: 'calendar_tasks_delete',
            request_id: req.requestId
          },
          request_params: { taskId },
          result
        }
      });
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Delete task route error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to delete task'
    });
  }
});

export default router;

