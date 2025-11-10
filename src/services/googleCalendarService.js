import { google } from 'googleapis';

/**
 * Create Google Calendar client with user's access token
 * @param {string} token - OAuth access token
 * @returns {google.calendar_v3.Calendar} Calendar API client
 */
export function getCalendar(token) {
  if (!token) {
    throw new Error('Access token is required');
  }
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: token });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

/**
 * Create a Google Calendar event
 * @param {string} token - OAuth access token
 * @param {Object} eventData - Event data
 * @param {string} eventData.summary - Event title
 * @param {string} eventData.startTime - Start time (ISO 8601)
 * @param {string} eventData.endTime - End time (ISO 8601)
 * @param {string} [eventData.timeZone] - Timezone (default: 'UTC')
 * @param {string} [eventData.description] - Event description
 * @param {Array} [eventData.attendees] - List of attendees
 * @returns {Promise<{success: boolean, event?: Object, error?: string}>}
 */
export async function createEvent(token, eventData) {
  try {
    if (!token) {
      return { success: false, error: 'Access token is required' };
    }
    if (!eventData?.summary || !eventData?.startTime || !eventData?.endTime) {
      return { success: false, error: 'Missing required fields: summary, startTime, endTime' };
    }

    const calendar = getCalendar(token);
    
    const event = {
      summary: eventData.summary,
      description: eventData.description || '',
      start: {
        dateTime: eventData.startTime,
        timeZone: eventData.timeZone || 'UTC',
      },
      end: {
        dateTime: eventData.endTime,
        timeZone: eventData.timeZone || 'UTC',
      },
      attendees: eventData.attendees || [],
      conferenceData: {
        createRequest: {
          requestId: `meet-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          conferenceSolutionKey: {
            type: 'hangoutsMeet'
          }
        }
      },
      conferenceDataVersion: 1
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      sendUpdates: 'all'
    });

    return {
      success: true,
      event: response.data
    };
  } catch (error) {
    console.error('Create event error:', error);
    return {
      success: false,
      error: error.message || 'Failed to create calendar event'
    };
  }
}

/**
 * Update a Google Calendar event
 * @param {string} token - OAuth access token
 * @param {string} eventId - Event ID to update
 * @param {Object} eventData - Updated event data (partial)
 * @returns {Promise<{success: boolean, event?: Object, error?: string}>}
 */
export async function updateEvent(token, eventId, eventData) {
  try {
    if (!token) {
      return { success: false, error: 'Access token is required' };
    }
    if (!eventId) {
      return { success: false, error: 'Event ID is required' };
    }

    const calendar = getCalendar(token);
    
    const existingEventResponse = await calendar.events.get({
      calendarId: 'primary',
      eventId: eventId
    });
    
    const existingEvent = existingEventResponse.data;
    
    const updatedEvent = {
      summary: eventData.summary || existingEvent.summary,
      description: eventData.description !== undefined ? eventData.description : existingEvent.description,
      start: eventData.startTime ? {
        dateTime: eventData.startTime,
        timeZone: eventData.timeZone || existingEvent.start.timeZone || 'UTC',
      } : existingEvent.start,
      end: eventData.endTime ? {
        dateTime: eventData.endTime,
        timeZone: eventData.timeZone || existingEvent.end.timeZone || 'UTC',
      } : existingEvent.end,
      attendees: eventData.attendees || existingEvent.attendees,
    };

    // Preserve existing conference data or create new
    if (existingEvent.conferenceData && existingEvent.conferenceData.entryPoints) {
      updatedEvent.conferenceData = existingEvent.conferenceData;
    } else {
      updatedEvent.conferenceData = {
        createRequest: {
          requestId: `meet-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          conferenceSolutionKey: {
            type: 'hangoutsMeet'
          }
        }
      };
      updatedEvent.conferenceDataVersion = 1;
    }

    const response = await calendar.events.update({
      calendarId: 'primary',
      eventId: eventId,
      resource: updatedEvent,
      sendUpdates: 'all'
    });

    return {
      success: true,
      event: response.data
    };
  } catch (error) {
    console.error('Update event error:', error);
    return {
      success: false,
      error: error.message || 'Failed to update calendar event'
    };
  }
}

/**
 * Get Google Calendar events with optional filters
 * @param {string} token - OAuth access token
 * @param {Object} filters - Filter options
 * @param {string} [filters.timeMin] - Minimum start time (ISO 8601)
 * @param {string} [filters.timeMax] - Maximum start time (ISO 8601)
 * @param {number} [filters.maxResults] - Maximum number of results (default: 100)
 * @param {string} [filters.q] - Search query
 * @returns {Promise<{success: boolean, events?: Array, error?: string}>}
 */
export async function getEvents(token, filters = {}) {
  try {
    if (!token) {
      return { success: false, error: 'Access token is required' };
    }

    const calendar = getCalendar(token);
    
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: filters.timeMin || new Date().toISOString(),
      timeMax: filters.timeMax,
      maxResults: filters.maxResults || 100,
      singleEvents: true,
      orderBy: 'startTime',
      q: filters.q,
    });

    return {
      success: true,
      events: response.data.items || []
    };
  } catch (error) {
    console.error('Get events error:', error);
    return {
      success: false,
      error: error.message || 'Failed to fetch calendar events'
    };
  }
}

/**
 * Delete a Google Calendar event
 * @param {string} token - OAuth access token
 * @param {string} eventId - Event ID to delete
 * @returns {Promise<{success: boolean, event?: Object, message?: string, error?: string}>}
 */
export async function deleteEvent(token, eventId) {
  try {
    if (!token) {
      return { success: false, error: 'Access token is required' };
    }
    if (!eventId) {
      return { success: false, error: 'Event ID is required' };
    }

    const calendar = getCalendar(token);
    
    // Fetch event details before deleting
    let eventDetails = null;
    try {
      const eventResponse = await calendar.events.get({
        calendarId: 'primary',
        eventId: eventId
      });
      eventDetails = eventResponse.data;
    } catch (error) {
      console.warn('Could not fetch event details before deletion:', error.message);
      // Continue with deletion even if fetch fails
    }
    
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: eventId,
    });

    return {
      success: true,
      event: eventDetails, // Return event details that were deleted
      message: 'Event deleted successfully'
    };
  } catch (error) {
    console.error('Delete event error:', error);
    return {
      success: false,
      error: error.message || 'Failed to delete calendar event'
    };
  }
}

