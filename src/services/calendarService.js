import { google } from 'googleapis';

// Create calendar client with user's access token
function getCalendar(accessToken) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// Create a calendar event
export async function createEvent(accessToken, eventData) {
  try {
    const calendar = getCalendar(accessToken);
    
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
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
    });

    return {
      success: true,
      event: response.data
    };
  } catch (error) {
    console.error('Create event error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Update a calendar event
export async function updateEvent(accessToken, eventId, eventData) {
  try {
    const calendar = getCalendar(accessToken);
    
    const event = {
      summary: eventData.summary,
      description: eventData.description,
      start: {
        dateTime: eventData.startTime,
        timeZone: eventData.timeZone || 'UTC',
      },
      end: {
        dateTime: eventData.endTime,
        timeZone: eventData.timeZone || 'UTC',
      },
      attendees: eventData.attendees,
    };

    const response = await calendar.events.update({
      calendarId: 'primary',
      eventId: eventId,
      resource: event,
    });

    return {
      success: true,
      event: response.data
    };
  } catch (error) {
    console.error('Update event error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Delete a calendar event
export async function deleteEvent(accessToken, eventId) {
  try {
    const calendar = getCalendar(accessToken);
    
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: eventId,
    });

    return {
      success: true,
      message: 'Event deleted successfully'
    };
  } catch (error) {
    console.error('Delete event error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

