import * as googleCalendarService from './googleCalendarService.js';
import * as outlookCalendarService from './outlookCalendarService.js';
import * as googleTasksService from './googleTasksService.js';
import * as outlookTasksService from './outlookTasksService.js';
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

    // Fetch events - use parallel fetching when type is 'both' for better performance
    if (type === 'both') {
      // Fetch from both calendars and tasks in parallel
      const [googleResult, outlookResult, googleTasksResult, outlookTasksResult] = await Promise.all([
        tokenForGoogle
          ? googleCalendarService.getEvents(tokenForGoogle, filters).catch(err => {
              console.error('Google Calendar fetch error:', err);
              return { success: false, events: [] };
            })
          : Promise.resolve({ success: false, events: [] }),
        tokenForOutlook
          ? outlookCalendarService.getEvents(tokenForOutlook, filters).catch(err => {
              console.error('Outlook Calendar fetch error:', err);
              return { success: false, events: [] };
            })
          : Promise.resolve({ success: false, events: [] }),
        tokenForGoogle
          ? googleTasksService.getTasks(tokenForGoogle, filters).catch(err => {
              console.warn('Google Tasks fetch error:', err.message);
              return { success: false, tasks: [] };
            })
          : Promise.resolve({ success: false, tasks: [] }),
        tokenForOutlook
          ? outlookTasksService.getTasks(tokenForOutlook, filters).catch(err => {
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
      // Single calendar - fetch sequentially (no performance benefit from parallel)
      // Fetch from Google Calendar
      if (type === 'google' || !type) {
        if (!tokenForGoogle) {
          console.warn('Google calendar type requested but no token provided');
        } else {
          try {
            // Fetch events and tasks in parallel
            const [eventsResult, tasksResult] = await Promise.all([
              googleCalendarService.getEvents(tokenForGoogle, filters).catch(err => {
                console.error('Google Calendar fetch error:', err);
                return { success: false, events: [] };
              }),
              googleTasksService.getTasks(tokenForGoogle, filters).catch(err => {
                console.warn('Google Tasks fetch error:', err.message);
                return { success: false, tasks: [] };
              })
            ]);

            if (eventsResult.success && eventsResult.events) {
              // Mark Google events with source
              const googleEvents = eventsResult.events.map(event => ({
                ...event,
                source: 'google',
                isTask: false
              }));
              allEvents.push(...googleEvents);
            }
            if (tasksResult.success && tasksResult.tasks) {
              // Mark tasks with source
              const tasks = tasksResult.tasks.map(task => ({
                ...task,
                source: 'google',
                isTask: true
              }));
              console.log(`[CalendarService] Adding ${tasks.length} tasks with isTask flag`);
              allEvents.push(...tasks);
            }
          } catch (error) {
            console.error('Google Calendar/Tasks fetch error:', error);
            // Continue even if fetch fails
          }
        }
      }

      // Fetch from Outlook Calendar
      if (type === 'outlook') {
        if (!tokenForOutlook) {
          console.warn('Outlook calendar type requested but no token provided');
        } else {
          try {
            // Fetch events and tasks in parallel
            const [eventsResult, tasksResult] = await Promise.all([
              outlookCalendarService.getEvents(tokenForOutlook, filters).catch(err => {
                console.error('Outlook Calendar fetch error:', err);
                return { success: false, events: [] };
              }),
              outlookTasksService.getTasks(tokenForOutlook, filters).catch(err => {
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
              // Mark Outlook tasks with source
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
            // Continue even if fetch fails
          }
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

/**
 * Get tasks from Google and/or Outlook task lists
 * @param {string} token - OAuth access token (from Authorization header)
 * @param {Object} filters - Filter options
 * @param {string} [userEmail] - User email for profile lookup
 * @param {string} [calendarType] - Explicit calendar type ('google', 'outlook', 'both')
 * @param {string} [additionalToken] - Additional token for 'both' type (from X-Additional-Token header)
 * @returns {Promise<{success: boolean, tasks?: Array, error?: string}>}
 */
export async function getTasks(token, filters = {}, userEmail = null, calendarType = null, additionalToken = null) {
  try {
    if (!token) {
      return { success: false, error: 'Access token is required' };
    }

    const type = await getCalendarType(userEmail, calendarType);
    const allTasks = [];

    // Determine which tokens to use based on calendar type
    const tokenForGoogle = (type === 'google' || type === 'both' || !type) ? token : null;
    const tokenForOutlook = (type === 'outlook') ? token : (type === 'both' ? additionalToken : null);

    if (type === 'both') {
      // Fetch from both task lists in parallel
      const [googleResult, outlookResult] = await Promise.all([
        tokenForGoogle
          ? googleTasksService.getTasks(tokenForGoogle, filters).catch(err => {
              console.warn('Google Tasks fetch error:', err.message);
              return { success: false, tasks: [] };
            })
          : Promise.resolve({ success: false, tasks: [] }),
        tokenForOutlook
          ? outlookTasksService.getTasks(tokenForOutlook, filters).catch(err => {
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
      // Single calendar - fetch sequentially
      if (type === 'google' || !type) {
        if (tokenForGoogle) {
          try {
            const result = await googleTasksService.getTasks(tokenForGoogle, filters);
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
      }

      if (type === 'outlook') {
        if (tokenForOutlook) {
          try {
            const result = await outlookTasksService.getTasks(tokenForOutlook, filters);
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
    }

    // Sort tasks by due date
    allTasks.sort((a, b) => {
      const aDue = new Date(a.start?.date || a.start?.dateTime || 0);
      const bDue = new Date(b.start?.date || b.start?.dateTime || 0);
      return aDue - bDue;
    });

    const limitedTasks = filters.maxResults 
      ? allTasks.slice(0, filters.maxResults)
      : allTasks;

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
 * Create a task - routes to appropriate service
 * @param {string} token - OAuth access token
 * @param {Object} taskData - Task data
 * @param {string} [calendarType='google'] - Calendar type ('google' or 'outlook')
 * @returns {Promise<{success: boolean, task?: Object, error?: string}>}
 */
export async function createTask(token, taskData, calendarType = 'google') {
  if (calendarType === 'outlook') {
    return await outlookTasksService.createTask(token, taskData);
  }
  return await googleTasksService.createTask(token, taskData);
}

/**
 * Update a task - routes to appropriate service
 * @param {string} token - OAuth access token
 * @param {string} taskId - Task ID to update
 * @param {Object} taskData - Updated task data
 * @param {string} [calendarType='google'] - Calendar type ('google' or 'outlook')
 * @returns {Promise<{success: boolean, task?: Object, error?: string}>}
 */
export async function updateTask(token, taskId, taskData, calendarType = 'google') {
  if (calendarType === 'outlook') {
    return await outlookTasksService.updateTask(token, taskId, taskData);
  }
  return await googleTasksService.updateTask(token, taskId, taskData);
}

/**
 * Delete a task - routes to appropriate service
 * @param {string} token - OAuth access token
 * @param {string} taskId - Task ID to delete
 * @param {string} [calendarType='google'] - Calendar type ('google' or 'outlook')
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export async function deleteTask(token, taskId, calendarType = 'google') {
  if (calendarType === 'outlook') {
    return await outlookTasksService.deleteTask(token, taskId);
  }
  return await googleTasksService.deleteTask(token, taskId);
}
