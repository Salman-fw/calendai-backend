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
    if (process.env.DEBUG_TASKS === 'true') {
      console.log(`[TasksService] Fetched ${allTasks.length} tasks from Google Tasks API`);
    }
    
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

/**
 * Create a new task in Google Tasks
 * @param {string} token - OAuth access token
 * @param {Object} taskData - Task data
 * @param {string} taskData.title - Task title (required)
 * @param {string} [taskData.notes] - Task notes/description
 * @param {string} [taskData.due] - Due date in RFC3339 format (YYYY-MM-DD)
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

    const tasksClient = getTasksClient(token);
    
    // Get task list ID if not provided
    let listId = taskListId;
    if (!listId) {
      const taskListsResponse = await tasksClient.tasklists.list({ maxResults: 1 });
      const taskLists = taskListsResponse.data.items || [];
      if (taskLists.length === 0) {
        return { success: false, error: 'No task lists available' };
      }
      listId = taskLists[0].id;
    }

    // Build task object
    const task = {
      title: taskData.title,
      notes: taskData.notes || '',
    };

    // Add due date if provided - normalize to RFC3339 format
    if (taskData.due) {
      // If due is just a date (YYYY-MM-DD), convert to RFC3339 with time (midnight UTC)
      if (/^\d{4}-\d{2}-\d{2}$/.test(taskData.due)) {
        // Date only - add time component (midnight UTC)
        task.due = `${taskData.due}T00:00:00.000Z`;
      } else {
        // Already has time component, use as-is
        task.due = taskData.due;
      }
    }

    const response = await tasksClient.tasks.insert({
      tasklist: listId,
      resource: task
    });

    return {
      success: true,
      task: response.data
    };
  } catch (error) {
    console.error('Create task error:', error);
    return {
      success: false,
      error: error.message || 'Failed to create task'
    };
  }
}

/**
 * Update an existing task in Google Tasks
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

    const tasksClient = getTasksClient(token);
    
    // Get task list ID if not provided
    let listId = taskListId;
    if (!listId) {
      const taskListsResponse = await tasksClient.tasklists.list({ maxResults: 1 });
      const taskLists = taskListsResponse.data.items || [];
      if (taskLists.length === 0) {
        return { success: false, error: 'No task lists available' };
      }
      listId = taskLists[0].id;
    }

    // First, get the existing task to merge updates
    let existingTask;
    try {
      const getResponse = await tasksClient.tasks.get({
        tasklist: listId,
        task: taskId
      });
      existingTask = getResponse.data;
    } catch (error) {
      return { success: false, error: `Task not found: ${error.message}` };
    }

    // Build update payload - only include fields that are being updated
    const updatePayload = {
      id: taskId,
      title: taskData.title !== undefined ? taskData.title : existingTask.title,
      notes: taskData.notes !== undefined ? taskData.notes : existingTask.notes,
    };

    // Update due date if provided - normalize to RFC3339 format
    if (taskData.due !== undefined) {
      if (taskData.due === null || taskData.due === '') {
        updatePayload.due = null; // Remove due date
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(taskData.due)) {
        // Date only - add time component (midnight UTC)
        updatePayload.due = `${taskData.due}T00:00:00.000Z`;
      } else {
        // Already has time component, use as-is
        updatePayload.due = taskData.due;
      }
    }

    const response = await tasksClient.tasks.update({
      tasklist: listId,
      task: taskId,
      resource: updatePayload
    });

    return {
      success: true,
      task: response.data
    };
  } catch (error) {
    console.error('Update task error:', error);
    return {
      success: false,
      error: error.message || 'Failed to update task'
    };
  }
}

/**
 * Delete a task from Google Tasks
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

    const tasksClient = getTasksClient(token);
    
    // Get task list ID if not provided
    let listId = taskListId;
    if (!listId) {
      const taskListsResponse = await tasksClient.tasklists.list({ maxResults: 1 });
      const taskLists = taskListsResponse.data.items || [];
      if (taskLists.length === 0) {
        return { success: false, error: 'No task lists available' };
      }
      listId = taskLists[0].id;
    }

    // Fetch task details before deleting
    let taskDetails = null;
    try {
      const getResponse = await tasksClient.tasks.get({
        tasklist: listId,
        task: taskId
      });
      taskDetails = getResponse.data;
    } catch (error) {
      console.warn('Could not fetch task details before deletion:', error.message);
      // Continue with deletion even if fetch fails
    }

    await tasksClient.tasks.delete({
      tasklist: listId,
      task: taskId
    });

    return {
      success: true,
      task: taskDetails,
      message: 'Task deleted successfully'
    };
  } catch (error) {
    console.error('Delete task error:', error);
    return {
      success: false,
      error: error.message || 'Failed to delete task'
    };
  }
}

