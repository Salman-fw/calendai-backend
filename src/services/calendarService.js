import * as googleCalendarService from './googleCalendarService.js';
import * as outlookCalendarService from './outlookCalendarService.js';
import * as googleTasksService from './googleTasksService.js';
import * as outlookTasksService from './outlookTasksService.js';
import { getOnboardingProfile } from './onboardingService.js';

/**
 * Router service that dispatches to appropriate calendar service based on primary calendar
 * Primary calendar: 'google' | 'outlook'
 */

/**
 * Normalize event times to UTC
 * @param {Object} event - Event object
 * @returns {Object} Event with normalized UTC times
 */
function normalizeEventToUTC(event) {
  if (!event) return event;
  
  const normalized = { ...event };
  
  // Normalize start time to UTC
  if (normalized.start?.dateTime) {
    // Only convert if dateTime is a valid ISO string
    const dateTimeStr = normalized.start.dateTime;
    // Check if already UTC (ends with Z) or has timezone offset
    if (dateTimeStr.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(dateTimeStr)) {
      const date = new Date(dateTimeStr);
      if (!isNaN(date.getTime())) {
        normalized.start = {
          ...normalized.start,
          dateTime: date.toISOString(),
          timeZone: 'UTC'
        };
      }
    }
  } else if (normalized.start?.date) {
    normalized.start = { ...normalized.start, timeZone: 'UTC' };
  }
  
  // Normalize end time to UTC
  if (normalized.end?.dateTime) {
    const dateTimeStr = normalized.end.dateTime;
    if (dateTimeStr.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(dateTimeStr)) {
      const date = new Date(dateTimeStr);
      if (!isNaN(date.getTime())) {
        normalized.end = {
          ...normalized.end,
          dateTime: date.toISOString(),
          timeZone: 'UTC'
        };
      }
    }
  } else if (normalized.end?.date) {
    normalized.end = { ...normalized.end, timeZone: 'UTC' };
  }
  
  return normalized;
}

/**
 * Get calendar events from Google and/or Outlook calendars
 * @param {string} googleToken - Google OAuth access token
 * @param {string} outlookToken - Outlook OAuth access token
 * @param {string} primaryCalendar - Primary calendar ('google' | 'outlook')
 * @param {Object} filters - Filter options
 * @param {string} [userEmail] - User email for profile lookup
 * @returns {Promise<{success: boolean, events?: Array, error?: string}>}
 */
export async function getEvents(googleToken, outlookToken, primaryCalendar, filters = {}, userEmail = null) {
  try {
    if (!googleToken && !outlookToken) {
      return { success: false, error: 'At least one access token is required' };
    }

    const allEvents = [];
    const hasBothTokens = googleToken && outlookToken;

    // Fetch events - use parallel fetching when both tokens available for better performance
    if (hasBothTokens) {
      // Fetch from both calendars and tasks in parallel
      const [googleResult, outlookResult, googleTasksResult, outlookTasksResult] = await Promise.all([
        googleToken
          ? googleCalendarService.getEvents(googleToken, filters).catch(err => {
              console.error('Google Calendar fetch error:', err);
              return { success: false, events: [] };
            })
          : Promise.resolve({ success: false, events: [] }),
        outlookToken
          ? outlookCalendarService.getEvents(outlookToken, filters).catch(err => {
              console.error('Outlook Calendar fetch error:', err);
              return { success: false, events: [] };
            })
          : Promise.resolve({ success: false, events: [] }),
        googleToken
          ? googleTasksService.getTasks(googleToken, filters).catch(err => {
              console.warn('Google Tasks fetch error:', err.message);
              return { success: false, tasks: [] };
            })
          : Promise.resolve({ success: false, tasks: [] }),
        outlookToken
          ? outlookTasksService.getTasks(outlookToken, filters).catch(err => {
              console.warn('Outlook Tasks fetch error:', err.message);
              return { success: false, tasks: [] };
            })
          : Promise.resolve({ success: false, tasks: [] })
      ]);

      if (googleResult.success && googleResult.events) {
        // Mark Google events with source
        const googleEvents = googleResult.events.map(event => ({
          ...event,
          source: 'google',
          isTask: false
        }));
        allEvents.push(...googleEvents);
      }
      if (outlookResult.success && outlookResult.events) {
        // Mark Outlook events with source
        const outlookEvents = outlookResult.events.map(event => ({
          ...event,
          source: 'outlook'
        }));
        allEvents.push(...outlookEvents);
      }
      if (googleTasksResult.success && googleTasksResult.tasks) {
        // Mark Google tasks with source
        const tasks = googleTasksResult.tasks.map(task => ({
          ...task,
          source: 'google',
          isTask: true
        }));
        console.log(`[CalendarService] Adding ${tasks.length} Google tasks with isTask flag`);
        allEvents.push(...tasks);
      }
      if (outlookTasksResult.success && outlookTasksResult.tasks) {
        // Mark Outlook tasks with source
        const tasks = outlookTasksResult.tasks.map(task => ({
          ...task,
          source: 'outlook',
          isTask: true
        }));
        console.log(`[CalendarService] Adding ${tasks.length} Outlook tasks with isTask flag`);
        allEvents.push(...tasks);
      }
    } else {
      // Single calendar - fetch from available token
      if (googleToken) {
        try {
          // Fetch events and tasks in parallel
          const [eventsResult, tasksResult] = await Promise.all([
            googleCalendarService.getEvents(googleToken, filters).catch(err => {
              console.error('Google Calendar fetch error:', err);
              return { success: false, events: [] };
            }),
            googleTasksService.getTasks(googleToken, filters).catch(err => {
              console.warn('Google Tasks fetch error:', err.message);
              return { success: false, tasks: [] };
            })
          ]);

          if (eventsResult.success && eventsResult.events) {
            const googleEvents = eventsResult.events.map(event => ({
              ...event,
              source: 'google',
              isTask: false
            }));
            allEvents.push(...googleEvents);
          }
          if (tasksResult.success && tasksResult.tasks) {
            const tasks = tasksResult.tasks.map(task => ({
              ...task,
              source: 'google',
              isTask: true
            }));
            console.log(`[CalendarService] Adding ${tasks.length} Google tasks with isTask flag`);
            allEvents.push(...tasks);
          }
        } catch (error) {
          console.error('Google Calendar/Tasks fetch error:', error);
        }
      }

      if (outlookToken) {
        try {
          // Fetch events and tasks in parallel
          const [eventsResult, tasksResult] = await Promise.all([
            outlookCalendarService.getEvents(outlookToken, filters).catch(err => {
              console.error('Outlook Calendar fetch error:', err);
              return { success: false, events: [] };
            }),
            outlookTasksService.getTasks(outlookToken, filters).catch(err => {
              console.warn('Outlook Tasks fetch error:', err.message);
                return { success: false, tasks: [] };
              })
            ]);

            if (eventsResult.success && eventsResult.events) {
              // Mark Outlook events with source
              const outlookEvents = eventsResult.events.map(event => ({
                ...event,
                source: 'outlook'
              }));
              allEvents.push(...outlookEvents);
            }
            if (tasksResult.success && tasksResult.tasks) {
              const tasks = tasksResult.tasks.map(task => ({
                ...task,
                source: 'outlook',
                isTask: true
              }));
              console.log(`[CalendarService] Adding ${tasks.length} Outlook tasks with isTask flag`);
              allEvents.push(...tasks);
            }
        } catch (error) {
          console.error('Outlook Calendar/Tasks fetch error:', error);
        }
      }
    }

    // Normalize all event times to UTC
    const normalizedEvents = allEvents.map(event => normalizeEventToUTC(event));

    // Sort all events by start time
    normalizedEvents.sort((a, b) => {
      const aStart = new Date(a.start?.dateTime || a.start?.date || 0);
      const bStart = new Date(b.start?.dateTime || b.start?.date || 0);
      return aStart - bStart;
    });

    // Limit results if needed
    const limitedEvents = filters.maxResults 
      ? normalizedEvents.slice(0, filters.maxResults)
      : normalizedEvents;

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
 * Create calendar event - routes to appropriate service based on primary calendar
 * @param {string} googleToken - Google OAuth access token
 * @param {string} outlookToken - Outlook OAuth access token
 * @param {string} primaryCalendar - Primary calendar ('google' | 'outlook')
 * @param {Object} eventData - Event data
 * @returns {Promise<{success: boolean, event?: Object, error?: string}>}
 */
export async function createEvent(googleToken, outlookToken, primaryCalendar, eventData) {
  const token = primaryCalendar === 'outlook' ? outlookToken : googleToken;
  if (!token) {
    return { success: false, error: `${primaryCalendar} token not available` };
  }
  
  if (primaryCalendar === 'outlook') {
    return await outlookCalendarService.createEvent(token, eventData);
  }
  return await googleCalendarService.createEvent(token, eventData);
}

/**
 * Update calendar event - routes to appropriate service based on primary calendar
 * @param {string} googleToken - Google OAuth access token
 * @param {string} outlookToken - Outlook OAuth access token
 * @param {string} primaryCalendar - Primary calendar ('google' | 'outlook')
 * @param {string} eventId - Event ID to update
 * @param {Object} eventData - Updated event data
 * @returns {Promise<{success: boolean, event?: Object, error?: string}>}
 */
export async function updateEvent(googleToken, outlookToken, primaryCalendar, eventId, eventData) {
  const token = primaryCalendar === 'outlook' ? outlookToken : googleToken;
  if (!token) {
    return { success: false, error: `${primaryCalendar} token not available` };
  }
  
  if (primaryCalendar === 'outlook') {
    return await outlookCalendarService.updateEvent(token, eventId, eventData);
  }
  return await googleCalendarService.updateEvent(token, eventId, eventData);
}

/**
 * Delete calendar event - routes to appropriate service based on primary calendar
 * @param {string} googleToken - Google OAuth access token
 * @param {string} outlookToken - Outlook OAuth access token
 * @param {string} primaryCalendar - Primary calendar ('google' | 'outlook')
 * @param {string} eventId - Event ID to delete
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export async function deleteEvent(googleToken, outlookToken, primaryCalendar, eventId) {
  const token = primaryCalendar === 'outlook' ? outlookToken : googleToken;
  if (!token) {
    return { success: false, error: `${primaryCalendar} token not available` };
  }
  
  if (primaryCalendar === 'outlook') {
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

/**
 * Get tasks from Google and/or Outlook task lists
 * @param {string} googleToken - Google OAuth access token
 * @param {string} outlookToken - Outlook OAuth access token
 * @param {string} primaryCalendar - Primary calendar ('google' | 'outlook')
 * @param {Object} filters - Filter options
 * @param {string} [userEmail] - User email for profile lookup
 * @returns {Promise<{success: boolean, tasks?: Array, error?: string}>}
 */
export async function getTasks(googleToken, outlookToken, primaryCalendar, filters = {}, userEmail = null) {
  try {
    if (!googleToken && !outlookToken) {
      return { success: false, error: 'At least one access token is required' };
    }

    const allTasks = [];
    const hasBothTokens = googleToken && outlookToken;

    if (hasBothTokens) {
      // Fetch from both task lists in parallel
      const [googleResult, outlookResult] = await Promise.all([
        googleToken
          ? googleTasksService.getTasks(googleToken, filters).catch(err => {
              console.warn('Google Tasks fetch error:', err.message);
              return { success: false, tasks: [] };
            })
          : Promise.resolve({ success: false, tasks: [] }),
        outlookToken
          ? outlookTasksService.getTasks(outlookToken, filters).catch(err => {
              console.warn('Outlook Tasks fetch error:', err.message);
              return { success: false, tasks: [] };
            })
          : Promise.resolve({ success: false, tasks: [] })
      ]);

      if (googleResult.success && googleResult.tasks) {
        const tasks = googleResult.tasks.map(task => ({
          ...task,
          source: 'google',
          isTask: true
        }));
        allTasks.push(...tasks);
      }
      if (outlookResult.success && outlookResult.tasks) {
        const tasks = outlookResult.tasks.map(task => ({
          ...task,
          source: 'outlook',
          isTask: true
        }));
        allTasks.push(...tasks);
      }
    } else {
      // Single calendar - fetch from available token
      if (googleToken) {
        try {
          const result = await googleTasksService.getTasks(googleToken, filters);
          if (result.success && result.tasks) {
            const tasks = result.tasks.map(task => ({
              ...task,
              source: 'google',
              isTask: true
            }));
            allTasks.push(...tasks);
          }
        } catch (error) {
          console.error('Google Tasks fetch error:', error);
        }
      }

      if (outlookToken) {
        try {
          const result = await outlookTasksService.getTasks(outlookToken, filters);
          if (result.success && result.tasks) {
            const tasks = result.tasks.map(task => ({
              ...task,
              source: 'outlook',
              isTask: true
            }));
            allTasks.push(...tasks);
          }
        } catch (error) {
          console.error('Outlook Tasks fetch error:', error);
        }
      }
    }

    // Normalize all task times to UTC
    const normalizedTasks = allTasks.map(task => normalizeEventToUTC(task));

    // Sort tasks by due date
    normalizedTasks.sort((a, b) => {
      const aDue = new Date(a.start?.date || a.start?.dateTime || 0);
      const bDue = new Date(b.start?.date || b.start?.dateTime || 0);
      return aDue - bDue;
    });

    const limitedTasks = filters.maxResults 
      ? normalizedTasks.slice(0, filters.maxResults)
      : normalizedTasks;

    return {
      success: true,
      tasks: limitedTasks
    };
  } catch (error) {
    console.error('Get tasks error:', error);
    return {
      success: false,
      error: error.message || 'Failed to fetch tasks'
    };
  }
}

/**
 * Create a task - routes to appropriate service based on primary calendar
 * @param {string} googleToken - Google OAuth access token
 * @param {string} outlookToken - Outlook OAuth access token
 * @param {string} primaryCalendar - Primary calendar ('google' | 'outlook')
 * @param {Object} taskData - Task data
 * @returns {Promise<{success: boolean, task?: Object, error?: string}>}
 */
export async function createTask(googleToken, outlookToken, primaryCalendar, taskData) {
  const token = primaryCalendar === 'outlook' ? outlookToken : googleToken;
  if (!token) {
    return { success: false, error: `${primaryCalendar} token not available` };
  }
  
  if (primaryCalendar === 'outlook') {
    return await outlookTasksService.createTask(token, taskData);
  }
  return await googleTasksService.createTask(token, taskData);
}

/**
 * Update a task - routes to appropriate service based on primary calendar
 * @param {string} googleToken - Google OAuth access token
 * @param {string} outlookToken - Outlook OAuth access token
 * @param {string} primaryCalendar - Primary calendar ('google' | 'outlook')
 * @param {string} taskId - Task ID to update
 * @param {Object} taskData - Updated task data
 * @returns {Promise<{success: boolean, task?: Object, error?: string}>}
 */
export async function updateTask(googleToken, outlookToken, primaryCalendar, taskId, taskData) {
  const token = primaryCalendar === 'outlook' ? outlookToken : googleToken;
  if (!token) {
    return { success: false, error: `${primaryCalendar} token not available` };
  }
  
  if (primaryCalendar === 'outlook') {
    return await outlookTasksService.updateTask(token, taskId, taskData);
  }
  return await googleTasksService.updateTask(token, taskId, taskData);
}

/**
 * Delete a task - routes to appropriate service based on primary calendar
 * @param {string} googleToken - Google OAuth access token
 * @param {string} outlookToken - Outlook OAuth access token
 * @param {string} primaryCalendar - Primary calendar ('google' | 'outlook')
 * @param {string} taskId - Task ID to delete
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export async function deleteTask(googleToken, outlookToken, primaryCalendar, taskId) {
  const token = primaryCalendar === 'outlook' ? outlookToken : googleToken;
  if (!token) {
    return { success: false, error: `${primaryCalendar} token not available` };
  }
  
  if (primaryCalendar === 'outlook') {
    return await outlookTasksService.deleteTask(token, taskId);
  }
  return await googleTasksService.deleteTask(token, taskId);
}
