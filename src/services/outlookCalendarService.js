import { convert } from 'html-to-text';

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Helper function to parse Microsoft Graph API errors
 * @param {Response} response - Fetch response object
 * @returns {Promise<string>} Error message
 */
async function parseGraphError(response) {
  let errorMessage = `Microsoft Graph API error: ${response.status}`;
  try {
    const errorData = await response.json();
    errorMessage = errorData.error?.message || errorMessage;
  } catch {
    const errorText = await response.text();
    if (errorText) errorMessage += ` - ${errorText}`;
  }
  return errorMessage;
}

/**
 * Transform Google Calendar event format to Microsoft Graph format
 * @param {Object} eventData - Google Calendar event data
 * @returns {Object} Microsoft Graph event format
 */
function transformToGraphFormat(eventData) {
  const graphEvent = {
    subject: eventData.summary || '',
    body: {
      contentType: 'HTML',
      content: eventData.description || ''
    },
    start: {
      dateTime: eventData.startTime,
      timeZone: eventData.timeZone || 'UTC'
    },
    end: {
      dateTime: eventData.endTime,
      timeZone: eventData.timeZone || 'UTC'
    }
  };

  // Add attendees if provided
  if (eventData.attendees && eventData.attendees.length > 0) {
    graphEvent.attendees = eventData.attendees.map(attendee => ({
      emailAddress: {
        address: typeof attendee === 'string' ? attendee : attendee.email,
        name: typeof attendee === 'string' ? attendee : attendee.displayName || attendee.email
      },
      type: 'required'
    }));
  }

  return graphEvent;
}

/**
 * Transform Microsoft Graph event format to Google Calendar format
 * @param {Object} graphEvent - Microsoft Graph event
 * @returns {Object} Google Calendar event format
 */
function transformFromGraphFormat(graphEvent) {
  // Extract plain text from HTML body - always convert if HTML tags are present
  let description = graphEvent.body?.content || '';
  if (description && (description.includes('<') || graphEvent.body?.contentType === 'HTML')) {
    try {
      description = convert(description, {
        wordwrap: false,
        preserveNewlines: false,
        trimEmptyLines: true,
        collapseWhitespace: true
      });
      // Post-process to reduce excessive whitespace
      description = description
        .replace(/\n{3,}/g, '\n\n')  // Max 2 consecutive newlines
        .replace(/[ \t]+/g, ' ')      // Collapse spaces/tabs
        .trim();
    } catch (error) {
      console.warn('[Outlook] Failed to convert HTML to text:', error.message);
    }
  }

  const transformed = {
    id: graphEvent.id,
    summary: graphEvent.subject || '',
    description,
    start: {
      dateTime: graphEvent.start?.dateTime,
      timeZone: graphEvent.start?.timeZone || 'UTC'
    },
    end: {
      dateTime: graphEvent.end?.dateTime,
      timeZone: graphEvent.end?.timeZone || 'UTC'
    },
    attendees: (graphEvent.attendees || []).map(a => ({
      email: a.emailAddress?.address,
      displayName: a.emailAddress?.name
    }))
  };

  // Extract Teams meeting link if available - match Google Calendar's structure
  const teamsLink = graphEvent.onlineMeeting?.joinUrl || graphEvent.onlineMeetingUrl;
  if (teamsLink) {
    // Add hangoutLink for frontend compatibility (same as Google Calendar)
    transformed.hangoutLink = teamsLink;
    // Also add conferenceData structure (for future frontend updates)
    transformed.conferenceData = {
      entryPoints: [{
        entryPointType: 'video',
        uri: teamsLink,
        label: teamsLink.split('/').pop() || teamsLink
      }]
    };
    // Keep onlineMeeting structure for frontend compatibility
    transformed.onlineMeeting = {
      joinUrl: teamsLink
    };
  }

  return transformed;
}

/**
 * Get Outlook calendar events
 * @param {string} token - OAuth access token
 * @param {Object} filters - Filter options
 * @param {string} [filters.timeMin] - Minimum start time (ISO 8601)
 * @param {string} [filters.timeMax] - Maximum start time (ISO 8601)
 * @param {number} [filters.maxResults] - Maximum number of results (default: 100)
 * @returns {Promise<{success: boolean, events?: Array, error?: string}>}
 */
export async function getEvents(token, filters = {}) {
  try {
    if (!token) {
      return { success: false, error: 'Access token is required' };
    }

    const timeMin = filters.timeMin || new Date().toISOString();
    const timeMax = filters.timeMax;
    const maxResults = filters.maxResults || 100;

    // Build URL with query parameters
    const url = new URL(`${GRAPH_API_BASE}/me/calendar/events`);
    url.searchParams.set('$top', maxResults.toString());
    url.searchParams.set('$orderby', 'start/dateTime');
    
    // Build $filter for date range
    const filterParts = [];
    if (timeMin) {
      filterParts.push(`start/dateTime ge '${timeMin}'`);
    }
    if (timeMax) {
      filterParts.push(`start/dateTime le '${timeMax}'`);
    }
    if (filterParts.length > 0) {
      url.searchParams.set('$filter', filterParts.join(' and '));
    }

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorMessage = await parseGraphError(response);
      throw new Error(errorMessage);
    }

    const data = await response.json();
    
    // Transform Microsoft Graph format to match Google Calendar format
    const events = (data.value || []).map(event => transformFromGraphFormat(event));

    return {
      success: true,
      events
    };
  } catch (error) {
    console.error('Get Outlook events error:', error);
    return {
      success: false,
      error: error.message || 'Failed to fetch calendar events'
    };
  }
}

/**
 * Create an Outlook calendar event
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

    // Transform to Microsoft Graph format
    const graphEvent = transformToGraphFormat(eventData);

    const response = await fetch(`${GRAPH_API_BASE}/me/calendar/events`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(graphEvent)
    });

    if (!response.ok) {
      const errorMessage = await parseGraphError(response);
      throw new Error(errorMessage);
    }

    const data = await response.json();
    
    // Transform response to Google Calendar format
    const event = transformFromGraphFormat(data);

    return {
      success: true,
      event
    };
  } catch (error) {
    console.error('Create Outlook event error:', error);
    return {
      success: false,
      error: error.message || 'Failed to create calendar event'
    };
  }
}

/**
 * Update an Outlook calendar event
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

    // First, get the existing event to merge updates
    const getResponse = await fetch(`${GRAPH_API_BASE}/me/calendar/events/${eventId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!getResponse.ok) {
      const errorMessage = await parseGraphError(getResponse);
      throw new Error(errorMessage);
    }

    const existingEvent = await getResponse.json();
    
    // Build update payload - only include fields that are being updated
    const updatePayload = {};
    
    if (eventData.summary !== undefined) {
      updatePayload.subject = eventData.summary;
    }
    
    if (eventData.description !== undefined) {
      updatePayload.body = {
        contentType: 'HTML',
        content: eventData.description
      };
    }
    
    if (eventData.startTime || eventData.endTime) {
      updatePayload.start = {
        dateTime: eventData.startTime || existingEvent.start.dateTime,
        timeZone: eventData.timeZone || existingEvent.start.timeZone || 'UTC'
      };
      updatePayload.end = {
        dateTime: eventData.endTime || existingEvent.end.dateTime,
        timeZone: eventData.timeZone || existingEvent.end.timeZone || 'UTC'
      };
    }
    
    if (eventData.attendees !== undefined) {
      updatePayload.attendees = eventData.attendees.map(attendee => ({
        emailAddress: {
          address: typeof attendee === 'string' ? attendee : attendee.email,
          name: typeof attendee === 'string' ? attendee : attendee.displayName || attendee.email
        },
        type: 'required'
      }));
    }

    // PATCH the event
    const patchResponse = await fetch(`${GRAPH_API_BASE}/me/calendar/events/${eventId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updatePayload)
    });

    if (!patchResponse.ok) {
      const errorMessage = await parseGraphError(patchResponse);
      throw new Error(errorMessage);
    }

    // Get updated event
    const updatedResponse = await fetch(`${GRAPH_API_BASE}/me/calendar/events/${eventId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!updatedResponse.ok) {
      const errorMessage = await parseGraphError(updatedResponse);
      throw new Error(errorMessage);
    }

    const updatedEvent = await updatedResponse.json();
    
    // Transform response to Google Calendar format
    const event = transformFromGraphFormat(updatedEvent);

    return {
      success: true,
      event
    };
  } catch (error) {
    console.error('Update Outlook event error:', error);
    return {
      success: false,
      error: error.message || 'Failed to update calendar event'
    };
  }
}

/**
 * Delete an Outlook calendar event
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

    // Fetch event details before deleting
    let eventDetails = null;
    try {
      const getResponse = await fetch(`${GRAPH_API_BASE}/me/calendar/events/${eventId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (getResponse.ok) {
        const graphEvent = await getResponse.json();
        // Transform to Google Calendar format for consistency
        eventDetails = transformFromGraphFormat(graphEvent);
      }
    } catch (error) {
      console.warn('Could not fetch event details before deletion:', error.message);
      // Continue with deletion even if fetch fails
    }

    const response = await fetch(`${GRAPH_API_BASE}/me/calendar/events/${eventId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const errorMessage = await parseGraphError(response);
      throw new Error(errorMessage);
    }

    return {
      success: true,
      event: eventDetails, // Return event details that were deleted
      message: 'Event deleted successfully'
    };
  } catch (error) {
    console.error('Delete Outlook event error:', error);
    return {
      success: false,
      error: error.message || 'Failed to delete calendar event'
    };
  }
}

