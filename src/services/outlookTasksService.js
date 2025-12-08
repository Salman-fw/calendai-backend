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
    if (process.env.DEBUG_TASKS === 'true') {
      console.log(`[OutlookTasksService] Fetched ${taskListCount} task lists from Outlook API`);
      console.log(`[OutlookTasksService] Task lists data: ${JSON.stringify(taskListsData, null, 2)}`);
    }

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
    if (process.env.DEBUG_TASKS === 'true') {
      console.log(`[OutlookTasksService] Fetched ${allTasks.length} tasks from Microsoft To Do API`);
    }
    
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

/**
 * Get default task list ID (first available list)
 * @param {string} token - OAuth access token
 * @returns {Promise<string|null>} Task list ID or null
 */
async function getDefaultTaskListId(token) {
  try {
    const response = await fetch(`${GRAPH_API_BASE}/me/todo/lists`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const taskLists = data.value || [];
    return taskLists.length > 0 ? taskLists[0].id : null;
  } catch (error) {
    console.error('Error getting default task list:', error);
    return null;
  }
}

/**
 * Transform task data to Microsoft Graph format
 * @param {Object} taskData - Task data in our format
 * @returns {Object} Microsoft Graph task format
 */
function transformToGraphTaskFormat(taskData) {
  const graphTask = {
    title: taskData.title || '',
  };

  if (taskData.notes) {
    graphTask.body = {
      contentType: 'text',
      content: taskData.notes
    };
  }

  if (taskData.due) {
    // Convert due date to Microsoft Graph format (ISO 8601 with time)
    // If it's just a date (YYYY-MM-DD), parse it and set to midnight UTC
    let dueDate;
    if (/^\d{4}-\d{2}-\d{2}$/.test(taskData.due)) {
      // Date only - parse as UTC midnight
      dueDate = new Date(`${taskData.due}T00:00:00.000Z`);
    } else {
      // Already has time component
      dueDate = new Date(taskData.due);
    }
    graphTask.dueDateTime = {
      dateTime: dueDate.toISOString(),
      timeZone: 'UTC'
    };
  }

  return graphTask;
}

/**
 * Transform Microsoft Graph task to our format
 * @param {Object} graphTask - Microsoft Graph task
 * @returns {Object} Task in our format
 */
function transformFromGraphTaskFormat(graphTask) {
  return {
    id: graphTask.id,
    title: graphTask.title || '',
    notes: graphTask.body?.content || '',
    due: graphTask.dueDateTime?.dateTime || null,
    status: graphTask.status || 'notStarted'
  };
}

/**
 * Create a new task in Microsoft To Do
 * @param {string} token - OAuth access token
 * @param {Object} taskData - Task data
 * @param {string} taskData.title - Task title (required)
 * @param {string} [taskData.notes] - Task notes/description
 * @param {string} [taskData.due] - Due date in ISO 8601 format
 * @param {string} [taskListId] - Task list ID (defaults to first available list)
 * @returns {Promise<{success: boolean, task?: Object, error?: string}>}
 */
export async function createTask(token, taskData, taskListId = null) {
  try {
    if (!token) {
      return { success: false, error: 'Access token is required' };
    }
    if (!taskData?.title) {
      return { success: false, error: 'Task title is required' };
    }

    // Get task list ID if not provided
    let listId = taskListId;
    if (!listId) {
      listId = await getDefaultTaskListId(token);
      if (!listId) {
        return { success: false, error: 'No task lists available' };
      }
    }

    // Transform to Microsoft Graph format
    const graphTask = transformToGraphTaskFormat(taskData);

    const response = await fetch(`${GRAPH_API_BASE}/me/todo/lists/${listId}/tasks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(graphTask)
    });

    if (!response.ok) {
      const errorMessage = await parseGraphError(response);
      throw new Error(errorMessage);
    }

    const data = await response.json();
    const task = transformFromGraphTaskFormat(data);

    return {
      success: true,
      task: task
    };
  } catch (error) {
    console.error('Create Outlook task error:', error);
    return {
      success: false,
      error: error.message || 'Failed to create Outlook task'
    };
  }
}

/**
 * Update an existing task in Microsoft To Do
 * @param {string} token - OAuth access token
 * @param {string} taskId - Task ID to update
 * @param {Object} taskData - Updated task data (partial)
 * @param {string} [taskListId] - Task list ID (defaults to first available list)
 * @returns {Promise<{success: boolean, task?: Object, error?: string}>}
 */
export async function updateTask(token, taskId, taskData, taskListId = null) {
  try {
    if (!token) {
      return { success: false, error: 'Access token is required' };
    }
    if (!taskId) {
      return { success: false, error: 'Task ID is required' };
    }

    // Get task list ID if not provided
    let listId = taskListId;
    if (!listId) {
      listId = await getDefaultTaskListId(token);
      if (!listId) {
        return { success: false, error: 'No task lists available' };
      }
    }

    // First, get the existing task to merge updates
    const getResponse = await fetch(`${GRAPH_API_BASE}/me/todo/lists/${listId}/tasks/${taskId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!getResponse.ok) {
      const errorMessage = await parseGraphError(getResponse);
      throw new Error(errorMessage);
    }

    const existingTask = await getResponse.json();
    
    // Build update payload - only include fields that are being updated
    const updatePayload = {};
    
    if (taskData.title !== undefined) {
      updatePayload.title = taskData.title;
    }
    
    if (taskData.notes !== undefined) {
      updatePayload.body = {
        contentType: 'text',
        content: taskData.notes
      };
    }
    
    if (taskData.due !== undefined) {
      if (taskData.due && taskData.due !== '') {
        // Convert due date to Microsoft Graph format
        let dueDate;
        if (/^\d{4}-\d{2}-\d{2}$/.test(taskData.due)) {
          // Date only - parse as UTC midnight
          dueDate = new Date(`${taskData.due}T00:00:00.000Z`);
        } else {
          // Already has time component
          dueDate = new Date(taskData.due);
        }
        updatePayload.dueDateTime = {
          dateTime: dueDate.toISOString(),
          timeZone: 'UTC'
        };
      } else {
        // Remove due date by setting to null
        updatePayload.dueDateTime = null;
      }
    }

    // Only send PATCH if there are updates
    if (Object.keys(updatePayload).length > 0) {
      const patchResponse = await fetch(`${GRAPH_API_BASE}/me/todo/lists/${listId}/tasks/${taskId}`, {
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
    }

    // Fetch updated task to return
    const updatedResponse = await fetch(`${GRAPH_API_BASE}/me/todo/lists/${listId}/tasks/${taskId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!updatedResponse.ok) {
      const errorMessage = await parseGraphError(updatedResponse);
      throw new Error(errorMessage);
    }

    const updatedTask = await updatedResponse.json();
    const task = transformFromGraphTaskFormat(updatedTask);

    return {
      success: true,
      task: task
    };
  } catch (error) {
    console.error('Update Outlook task error:', error);
    return {
      success: false,
      error: error.message || 'Failed to update Outlook task'
    };
  }
}

/**
 * Delete a task from Microsoft To Do
 * @param {string} token - OAuth access token
 * @param {string} taskId - Task ID to delete
 * @param {string} [taskListId] - Task list ID (defaults to first available list)
 * @returns {Promise<{success: boolean, task?: Object, message?: string, error?: string}>}
 */
export async function deleteTask(token, taskId, taskListId = null) {
  try {
    if (!token) {
      return { success: false, error: 'Access token is required' };
    }
    if (!taskId) {
      return { success: false, error: 'Task ID is required' };
    }

    // Get task list ID if not provided
    let listId = taskListId;
    if (!listId) {
      listId = await getDefaultTaskListId(token);
      if (!listId) {
        return { success: false, error: 'No task lists available' };
      }
    }

    // Fetch task details before deleting
    let taskDetails = null;
    try {
      const getResponse = await fetch(`${GRAPH_API_BASE}/me/todo/lists/${listId}/tasks/${taskId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      if (getResponse.ok) {
        const graphTask = await getResponse.json();
        taskDetails = transformFromGraphTaskFormat(graphTask);
      }
    } catch (error) {
      console.warn('Could not fetch task details before deletion:', error.message);
    }

    const response = await fetch(`${GRAPH_API_BASE}/me/todo/lists/${listId}/tasks/${taskId}`, {
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
      task: taskDetails,
      message: 'Task deleted successfully'
    };
  } catch (error) {
    console.error('Delete Outlook task error:', error);
    return {
      success: false,
      error: error.message || 'Failed to delete Outlook task'
    };
  }
}

/**
 * Helper function to parse Microsoft Graph API errors
 * @param {Response} response - Fetch response object
 * @returns {Promise<string>} Error message
 */
async function parseGraphError(response) {
  let errorMessage = `Microsoft Graph API error: ${response.status}`;
  try {
    const errorData = await response.json();
    errorMessage = errorData.error?.message || errorData.error?.code || errorMessage;
  } catch {
    const errorText = await response.text();
    if (errorText) errorMessage += ` - ${errorText}`;
  }
  return errorMessage;
}

