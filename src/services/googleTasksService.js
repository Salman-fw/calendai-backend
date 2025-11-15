import { google } from 'googleapis';

/**
 * Create Google Tasks client with user's access token
 * @param {string} token - OAuth access token
 * @returns {google.tasks_v1.Tasks} Tasks API client
 */
function getTasksClient(token) {
  if (!token) {
    throw new Error('Access token is required');
  }
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: token });
  return google.tasks({ version: 'v1', auth: oauth2Client });
}

/**
 * Fetch tasks from Google Tasks API
 * @param {string} token - OAuth access token
 * @param {Object} filters - Filter options
 * @param {string} [filters.timeMin] - Minimum due date (ISO 8601)
 * @param {string} [filters.timeMax] - Maximum due date (ISO 8601)
 * @param {number} [filters.maxResults] - Maximum number of tasks to return
 * @returns {Promise<{success: boolean, tasks?: Array, error?: string}>}
 */
export async function getTasks(token, filters = {}) {
  try {
    if (!token) {
      return { success: false, error: 'Access token is required' };
    }

    const tasksClient = getTasksClient(token);
    
    // Get all task lists
    const taskListsResponse = await tasksClient.tasklists.list({
      maxResults: 10
    });
    
    const taskListIds = (taskListsResponse.data.items || []).map(list => list.id);
    
    if (taskListIds.length === 0) {
      return { success: true, tasks: [] };
    }
    
    // Fetch tasks from all task lists in parallel
    // Note: dueMin/dueMax will filter out tasks without due dates
    // We fetch all incomplete tasks and filter by date range in code
    const taskPromises = taskListIds.map(async (taskListId) => {
      try {
        const tasksResponse = await tasksClient.tasks.list({
          tasklist: taskListId,
          showCompleted: false, // Only show incomplete tasks
          // Don't use dueMin/dueMax here - fetch all incomplete tasks and filter in code
          maxResults: filters.maxResults || 100
        });
        const tasks = tasksResponse.data.items || [];
        
        // Filter tasks by date range if filters provided
        if (filters.timeMin || filters.timeMax) {
          return tasks.filter(task => {
            if (!task.due) {
              // Tasks without due date: always include them (they'll be assigned today's date)
              // This ensures tasks without due dates appear in any view
              return true;
            }
            const dueDate = new Date(task.due);
            const minDate = filters.timeMin ? new Date(filters.timeMin) : null;
            const maxDate = filters.timeMax ? new Date(filters.timeMax) : null;
            
            if (minDate && dueDate < minDate) return false;
            if (maxDate && dueDate > maxDate) return false;
            return true;
          });
        }
        
        return tasks;
      } catch (error) {
        console.warn(`Failed to fetch tasks from list ${taskListId}:`, error.message);
        return [];
      }
    });
    
    const allTasks = (await Promise.all(taskPromises)).flat();
    console.log(`[TasksService] Fetched ${allTasks.length} tasks from Google Tasks API`);
    
    // Transform tasks to match calendar event format
    const transformedTasks = allTasks
      .filter(task => task.title) // Only include tasks with a title
      .map(task => {
        // Use due date if available, otherwise use the start of the filter range or today
        let dueDate;
        if (task.due) {
          dueDate = new Date(task.due);
        } else {
          // For tasks without due date, use the start of the filter range (or today if no filter)
          // This ensures they appear in the current view
          if (filters.timeMin) {
            dueDate = new Date(filters.timeMin);
          } else {
            dueDate = new Date();
          }
        }
        const dueDateStr = dueDate.toISOString().split('T')[0]; // YYYY-MM-DD format
        
        return {
          id: task.id,
          summary: task.title || '',
          description: task.notes || '',
          start: {
            date: dueDateStr,
            dateTime: null
          },
          end: {
            date: dueDateStr,
            dateTime: null
          },
          location: '',
          attendees: [],
          isTask: true
        };
      });

    return {
      success: true,
      tasks: transformedTasks
    };
  } catch (error) {
    console.error('Get tasks error:', error);
    return {
      success: false,
      error: error.message || 'Failed to fetch tasks'
    };
  }
}

