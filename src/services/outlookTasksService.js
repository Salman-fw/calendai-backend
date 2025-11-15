const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Fetch tasks from Microsoft To Do API (Outlook Tasks)
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

    // Get all task lists (To Do lists)
    // Try the endpoint - if it fails, it's likely a permissions issue
    let taskListsResponse;
    try {
      taskListsResponse = await fetch(`${GRAPH_API_BASE}/me/todo/lists`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
    } catch (networkError) {
      console.error('[OutlookTasksService] Network error fetching task lists:', networkError.message);
      return { success: true, tasks: [] };
    }

    if (!taskListsResponse.ok) {
      let errorMessage = `HTTP ${taskListsResponse.status}`;
      try {
        const errorData = await taskListsResponse.json();
        errorMessage = errorData.error?.message || errorData.error?.code || errorMessage;
        console.warn(`[OutlookTasksService] Failed to fetch task lists (${taskListsResponse.status}):`, errorMessage);
        
        // If it's a permissions error, log helpful message
        if (taskListsResponse.status === 403 || taskListsResponse.status === 401) {
          console.warn('[OutlookTasksService] This might be due to missing Tasks.Read permission. User may need to re-authenticate.');
        }
      } catch (e) {
        const errorText = await taskListsResponse.text();
        console.warn('[OutlookTasksService] Failed to fetch Outlook task lists:', errorText);
      }
      // Return empty array instead of error - tasks are optional
      return { success: true, tasks: [] };
    }

    const taskListsData = await taskListsResponse.json();
    const taskListCount = (taskListsData.value || []).length;
    console.log(`[OutlookTasksService] Fetched ${taskListCount} task lists from Outlook API`);

    const taskListIds = (taskListsData.value || []).map(list => list.id);
    
    if (taskListIds.length === 0) {
      return { success: true, tasks: [] };
    }
    
    // Fetch tasks from all task lists in parallel
    const taskPromises = taskListIds.map(async (taskListId) => {
      try {
        // Fetch tasks from this list
        // Fetch all tasks and filter in code (more reliable than OData filter)
        const url = new URL(`${GRAPH_API_BASE}/me/todo/lists/${taskListId}/tasks`);
        url.searchParams.set('$top', (filters.maxResults || 100).toString());
        
        const tasksResponse = await fetch(url.toString(), {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });

        if (!tasksResponse.ok) {
          let errorMsg = `HTTP ${tasksResponse.status}`;
          try {
            const errorData = await tasksResponse.json();
            errorMsg = errorData.error?.message || errorData.error?.code || errorMsg;
          } catch (e) {
            errorMsg = tasksResponse.statusText;
          }
          console.warn(`[OutlookTasksService] Failed to fetch tasks from list ${taskListId}: ${errorMsg}`);
          return [];
        }

        const tasksData = await tasksResponse.json();
        let tasks = tasksData.value || [];
        
        // Filter out completed tasks
        tasks = tasks.filter(task => task.status !== 'completed');
        
        // Filter tasks by date range if filters provided
        if (filters.timeMin || filters.timeMax) {
          tasks = tasks.filter(task => {
            if (!task.dueDateTime) {
              // Tasks without due date: always include them
              return true;
            }
            const dueDate = new Date(task.dueDateTime.dateTime);
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
    console.log(`[OutlookTasksService] Fetched ${allTasks.length} tasks from Microsoft To Do API`);
    
    // Transform tasks to match calendar event format
    const transformedTasks = allTasks
      .filter(task => task.title) // Only include tasks with a title
      .map(task => {
        // Use due date if available, otherwise use the start of the filter range or today
        let dueDate;
        if (task.dueDateTime?.dateTime) {
          dueDate = new Date(task.dueDateTime.dateTime);
        } else {
          // For tasks without due date, use the start of the filter range (or today if no filter)
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
          description: task.body?.content || '',
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
    console.error('Get Outlook tasks error:', error);
    return {
      success: false,
      error: error.message || 'Failed to fetch Outlook tasks'
    };
  }
}

