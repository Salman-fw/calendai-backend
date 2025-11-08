const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

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
      let errorMessage = `Microsoft Graph API error: ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.error?.message || errorMessage;
      } catch {
        const errorText = await response.text();
        if (errorText) errorMessage += ` - ${errorText}`;
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    
    // Transform Microsoft Graph format to match Google Calendar format
    const events = (data.value || []).map(event => ({
      id: event.id,
      summary: event.subject || '',
      description: event.body?.content || '',
      start: {
        dateTime: event.start?.dateTime,
        timeZone: event.start?.timeZone || 'UTC'
      },
      end: {
        dateTime: event.end?.dateTime,
        timeZone: event.end?.timeZone || 'UTC'
      },
      attendees: (event.attendees || []).map(a => ({
        email: a.emailAddress?.address,
        displayName: a.emailAddress?.name
      }))
    }));

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

