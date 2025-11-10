import * as googleCalendarService from './googleCalendarService.js';
import * as outlookCalendarService from './outlookCalendarService.js';
import { getOnboardingProfile } from './onboardingService.js';

/**
 * Router service that dispatches to appropriate calendar service based on type
 * Calendar type: 'google' | 'outlook' | 'both' | null (defaults to 'google')
 */

/**
 * Determine calendar type from explicit parameter or user profile
 * @param {string} [userEmail] - User email for profile lookup
 * @param {string} [calendarType] - Explicit calendar type
 * @returns {Promise<string>} Calendar type ('google', 'outlook', or 'both')
 */
async function getCalendarType(userEmail, calendarType) {
  if (calendarType) return calendarType;
  
  // Fallback to onboarding profile if type not provided
  if (userEmail) {
    try {
      const profile = await getOnboardingProfile(userEmail);
      return profile?.calendars || 'google';
    } catch (error) {
      console.error('Error fetching onboarding profile:', error);
      return 'google'; // Default on error
    }
  }
  
  return 'google'; // Default
}

/**
 * Get calendar events from Google and/or Outlook calendars
 * @param {string} token - OAuth access token (from Authorization header)
 * @param {Object} filters - Filter options
 * @param {string} [userEmail] - User email for profile lookup
 * @param {string} [calendarType] - Explicit calendar type ('google', 'outlook', 'both')
 * @param {string} [additionalToken] - Additional token for 'both' type (from X-Additional-Token header)
 * @returns {Promise<{success: boolean, events?: Array, error?: string}>}
 */
export async function getEvents(token, filters = {}, userEmail = null, calendarType = null, additionalToken = null) {
  try {
    if (!token) {
      return { success: false, error: 'Access token is required' };
    }

    const type = await getCalendarType(userEmail, calendarType);
    const allEvents = [];

    // Determine which tokens to use based on calendar type:
    // - 'google' or null: use token for Google Calendar
    // - 'outlook': use token for Outlook Calendar
    // - 'both': use token for Google Calendar, additionalToken for Outlook Calendar
    const tokenForGoogle = (type === 'google' || type === 'both' || !type) ? token : null;
    const tokenForOutlook = (type === 'outlook') ? token : (type === 'both' ? additionalToken : null);

    // Fetch from Google Calendar
    if (type === 'google' || type === 'both') {
      if (!tokenForGoogle) {
        console.warn('Google calendar type requested but no token provided');
      } else {
        try {
          const result = await googleCalendarService.getEvents(tokenForGoogle, filters);
          if (result.success && result.events) {
            allEvents.push(...result.events);
          }
        } catch (error) {
          console.error('Google Calendar fetch error:', error);
          // Continue with other calendars even if one fails
        }
      }
    }

    // Fetch from Outlook Calendar
    if (type === 'outlook' || type === 'both') {
      if (!tokenForOutlook) {
        console.warn('Outlook calendar type requested but no token provided');
      } else {
        try {
          const result = await outlookCalendarService.getEvents(tokenForOutlook, filters);
          if (result.success && result.events) {
            allEvents.push(...result.events);
          }
        } catch (error) {
          console.error('Outlook Calendar fetch error:', error);
          // Continue with other calendars even if one fails
        }
      }
    }

    // Sort all events by start time
    allEvents.sort((a, b) => {
      const aStart = new Date(a.start?.dateTime || a.start?.date || 0);
      const bStart = new Date(b.start?.dateTime || b.start?.date || 0);
      return aStart - bStart;
    });

    // Limit results if needed
    const limitedEvents = filters.maxResults 
      ? allEvents.slice(0, filters.maxResults)
      : allEvents;

    return {
      success: true,
      events: limitedEvents
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
 * Create calendar event - routes to appropriate service
 * @param {string} token - OAuth access token
 * @param {Object} eventData - Event data
 * @param {string} [calendarType='google'] - Calendar type ('google' or 'outlook')
 * @returns {Promise<{success: boolean, event?: Object, error?: string}>}
 */
export async function createEvent(token, eventData, calendarType = 'google') {
  if (calendarType === 'outlook') {
    return await outlookCalendarService.createEvent(token, eventData);
  }
  return await googleCalendarService.createEvent(token, eventData);
}

/**
 * Update calendar event - routes to appropriate service
 * @param {string} token - OAuth access token
 * @param {string} eventId - Event ID to update
 * @param {Object} eventData - Updated event data
 * @param {string} [calendarType='google'] - Calendar type ('google' or 'outlook')
 * @returns {Promise<{success: boolean, event?: Object, error?: string}>}
 */
export async function updateEvent(token, eventId, eventData, calendarType = 'google') {
  if (calendarType === 'outlook') {
    return await outlookCalendarService.updateEvent(token, eventId, eventData);
  }
  return await googleCalendarService.updateEvent(token, eventId, eventData);
}

/**
 * Delete calendar event - routes to appropriate service
 * @param {string} token - OAuth access token
 * @param {string} eventId - Event ID to delete
 * @param {string} [calendarType='google'] - Calendar type ('google' or 'outlook')
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export async function deleteEvent(token, eventId, calendarType = 'google') {
  if (calendarType === 'outlook') {
    return await outlookCalendarService.deleteEvent(token, eventId);
  }
  return await googleCalendarService.deleteEvent(token, eventId);
}

/**
 * Get Google Calendar client - exported for backward compatibility
 * @param {string} token - OAuth access token
 * @returns {google.calendar_v3.Calendar} Calendar API client
 */
export function getCalendar(token) {
  return googleCalendarService.getCalendar(token);
}
