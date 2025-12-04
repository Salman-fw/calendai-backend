import express from 'express';
import multer from 'multer';
import { transcribeAudio } from '../services/whisperService.js';
import { processWithLLM } from '../services/llmService.js';
import { getEvents, createEvent, updateEvent, deleteEvent, getCalendar, getTasks, createTask, updateTask, deleteTask } from '../services/calendarService.js';
import logger from '../utils/appLogger.js';
import { recordInteractionLog } from '../utils/interactionLogger.js';
// Note: authAndRateLimit middleware is applied at app level (/api), so extractToken is not needed

const router = express.Router();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// Helper function to format time with user's timezone
function formatTimeWithUserTimezone(dateString, req) {
  const date = new Date(dateString);
  const timezoneOffset = req.headers['x-device-timezone-offset'];
  const deviceTimezone = req.headers['x-device-timezone'];
  
  if (timezoneOffset) {
    const offsetMinutes = parseInt(timezoneOffset);
    const userLocalTime = new Date(date.getTime() + offsetMinutes * 60000);
    return userLocalTime.toLocaleString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }
  
  // Fallback to device timezone if available
  if (deviceTimezone) {
    try {
      return date.toLocaleString('en-US', {
        timeZone: deviceTimezone,
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
    } catch (error) {
      console.error('Invalid timezone:', deviceTimezone);
    }
  }
  
  // Final fallback
  return date.toLocaleString();
}

// Helper function to check for meeting conflicts
async function checkMeetingConflict(googleToken, outlookToken, primaryCalendar, startTime, endTime, excludeEventId = null, userEmail = null) {
  try {
    if (!startTime || !endTime) {
      return null;
    }

    const start = new Date(startTime);
    const end = new Date(endTime);

    // Fetch events in a slightly wider range to catch any overlaps
    const searchStart = new Date(start);
    searchStart.setHours(searchStart.getHours() - 1);
    const searchEnd = new Date(end);
    searchEnd.setHours(searchEnd.getHours() + 1);

    if (primaryCalendar === 'google')
      outlookToken = null;
    else if (primaryCalendar === 'outlook')
      googleToken = null;

    const eventsResult = await getEvents(googleToken, outlookToken, primaryCalendar, {
      timeMin: searchStart.toISOString(),
      timeMax: searchEnd.toISOString()
    }, userEmail);

    if (!eventsResult.success || !eventsResult.events) {
      return null;
    }

    // Filter out tasks and the event being updated (if any)
    const meetings = eventsResult.events.filter(event => {
      // Exclude tasks
      if (event.isTask) {
        return false;
      }
      // Exclude the event being updated
      if (excludeEventId && event.id === excludeEventId) {
        return false;
      }
      return true;
    });

    // Check for overlaps
    for (const meeting of meetings) {
      const meetingStart = new Date(meeting.start?.dateTime || meeting.start?.date);
      const meetingEnd = new Date(meeting.end?.dateTime || meeting.end?.date);

      // Two events overlap if: newStart < existingEnd AND newEnd > existingStart
      if (start < meetingEnd && end > meetingStart) {
        return {
          id: meeting.id,
          summary: meeting.summary,
          start: meeting.start,
          end: meeting.end,
          attendees: meeting.attendees
        };
      }
    }

    return null;
  } catch (error) {
    console.error('Error checking meeting conflict:', error);
    return null;
  }
}

// Execute calendar function based on GPT tool call
async function executeTool(toolCall, googleToken, outlookToken, primaryCalendar, userEmail = null) {
  const { name, arguments: args } = toolCall.function;
  const params = JSON.parse(args);

  console.log(`Executing tool: ${name} with params:`, params);

  // Calendar is now required in all tool calls - use it directly
  const calendar = params.calendar;
  
  // Remove calendar from params before passing to service functions
  const { calendar: _, ...serviceParams } = params;

  switch (name) {
    case 'list_calendar_events':
      return await getEvents(googleToken, outlookToken, calendar, serviceParams, userEmail);

    case 'list_tasks':
      return await getTasks(googleToken, outlookToken, calendar, serviceParams, userEmail);

    case 'create_calendar_event':
      return await createEvent(googleToken, outlookToken, calendar, serviceParams);

    case 'update_calendar_event':
      return await updateEvent(googleToken, outlookToken, calendar, serviceParams.eventId, serviceParams);

    case 'delete_calendar_event':
      return await deleteEvent(googleToken, outlookToken, calendar, serviceParams.eventId);

    case 'create_task':
      return await createTask(googleToken, outlookToken, calendar, serviceParams);

    case 'update_task':
      return await updateTask(googleToken, outlookToken, calendar, serviceParams.taskId, serviceParams);

    case 'delete_task':
      return await deleteTask(googleToken, outlookToken, calendar, serviceParams.taskId);

    default:
      return { success: false, error: `Unknown tool: ${name}` };
  }
}

// POST /api/voice/test - Test LLM without calendar (no auth required)
router.post('/test', upload.single('audio'), async (req, res) => {
  try {
    let userMessage;
    
    if (req.body.text) {
      userMessage = req.body.text;
    } else {
      return res.status(400).json({ success: false, error: 'Text input required' });
    }

    const conversationHistory = [{ role: 'user', content: userMessage }];
    const llmResponse = await processWithLLM(conversationHistory, '', {}, 'text', 'google');

    return res.json({
      success: true,
      response: llmResponse.message,
      test: true
    });
  } catch (error) {
    console.error('LLM test error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/voice/command - Process voice or text command
// Note: authAndRateLimit middleware (applied at /api level) already extracts tokens and sets req.googleToken, req.outlookToken, req.primaryCalendar
router.post('/command', upload.single('audio'), async (req, res) => {
  try {
    let userMessage;
    let conversationHistory = [];
    let inputModality = 'voice';
    const loggingCalendarType = req.query.type || 'google';

    // Parse conversation history if provided
    if (req.body.history) {
      try {
        conversationHistory = JSON.parse(req.body.history);
      } catch (e) {
        console.error('Failed to parse history:', e);
      }
    }

    // Handle audio input
    if (req.file) {
    // Reject audio larger than 1.5 MB
    const MAX_AUDIO_BYTES = 1.5 * 1024 * 1024;
    if (req.file.size && req.file.size > MAX_AUDIO_BYTES) {
      return res.json({
        success: true,
        response: "I'm sorry, I couldn't keep track of what you're saying. Could you summarize ? For longer commands, you can also consider upgrading to our Kalendra Plus plan !"
      });
    }

      const transcription = await transcribeAudio(req.file.buffer, req.file.originalname);
      
      if (!transcription.success) {
        return res.status(500).json(transcription);
      }

      userMessage = transcription.text;
    } 
    // Handle text input (for follow-ups)
    else if (req.body.text) {
      userMessage = req.body.text;
    } 
    else {
      return res.status(400).json({
        success: false,
        error: 'Either audio file or text input required'
      });
    }

    inputModality = req.file ? 'voice' : 'text';

    // Fetch context (today's meetings + recent contacts)
    let contextInfo = '';
    
    try {
      const googleToken = req.googleToken;
      const outlookToken = req.outlookToken;
      const primaryCalendar = req.primaryCalendar;
      
      const start = new Date();
      start.setDate(start.getDate() - 1); 
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      
      const events = await getEvents(googleToken, outlookToken, primaryCalendar, {
        timeMin: start.toISOString(),
        timeMax: end.toISOString()
      }, req.user?.email);

      if (events.success && events.events.length > 0) {
        const meetingsList = events.events
          .map(e => {
            const start = new Date(e.start.dateTime || e.start.date);
            const time = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            return `${time} - ${e.summary} (ID: ${e.id})`;
          })
          .join(', ');
        contextInfo += `Today's meetings: ${meetingsList}\n`;
      }

      const twoMonthsAgo = new Date();
      twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
      
      const recentEvents = await getEvents(googleToken, outlookToken, primaryCalendar, {
        timeMin: twoMonthsAgo.toISOString(),
        maxResults: 50
      }, req.user?.email);

      if (recentEvents.success) {
        const contactMap = new Map(); // email -> {name, email}
        recentEvents.events.forEach(event => {
          if (event.attendees) {
            event.attendees.forEach(a => {
              if (a.email && a.displayName) {
                contactMap.set(a.email, {
                  name: a.displayName,
                  email: a.email
                });
              }
            });
          }
        });
        
        if (contactMap.size > 0) {
          const contactsList = Array.from(contactMap.values())
            .map(c => `${c.name} (${c.email})`)
            .join(', ');
          contextInfo += `Recent contacts: ${contactsList}`;
        }
      }
    } catch (error) {
      console.error('Failed to fetch context:', error);
    }

    // Add current user message to history
    conversationHistory.push({
      role: 'user',
      content: userMessage
    });

    // Process with LLM
    console.log('🔍 DEBUG - Transcribed text:', userMessage);
    console.log('🔍 DEBUG - Conversation history before LLM:', JSON.stringify(conversationHistory, null, 2));
    console.log('🔍 DEBUG - Context info:', contextInfo);

    // Extract timezone and timestamp information from headers
    const timezoneInfo = {
      deviceTimezone: req.headers['x-device-timezone'],
      timezoneOffset: req.headers['x-device-timezone-offset'],
      deviceTimestamp: req.headers['x-device-timestamp']
    };

    const llmStart = Date.now();
    const llmResponse = await processWithLLM(conversationHistory, contextInfo, timezoneInfo);
    const llmLatencyMs = Date.now() - llmStart;

    if (!llmResponse.success) {
      console.log('❌ DEBUG - LLM response failed:', llmResponse.error);
      return res.status(500).json(llmResponse);
    }

    console.log('✅ DEBUG - LLM response success:', JSON.stringify(llmResponse, null, 2));

    // Check if GPT wants to call a tool
    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      const toolCall = llmResponse.toolCalls[0];
      const { name, arguments: args } = toolCall.function;
      const params = JSON.parse(args);
      const toolPayload = {
        modality: inputModality,
        user_instruction: userMessage,
        llm_interaction: llmResponse.message,
        tool_call: {
          name,
          arguments: params
        },
        metadata: {
          endpoint: 'voice_command',
          request_id: req.requestId,
          latency_ms: llmLatencyMs
        }
      };

      // Check if this is a read-only action (execute immediately)
      if (name === 'list_calendar_events') {
        const toolResult = await executeTool(
          toolCall,
          req.googleToken,
          req.outlookToken,
          req.primaryCalendar,
          req.user?.email
        );

        conversationHistory.push({
          role: 'assistant',
          content: null,
          tool_calls: llmResponse.toolCalls
        });

        conversationHistory.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult)
        });

        const finalResponse = await processWithLLM(conversationHistory, '', {}, inputModality, req.primaryCalendar);

        await recordInteractionLog(req, {
          actionType: name || 'converse',
          calendarType: loggingCalendarType,
          payload: {
            ...toolPayload,
            llm_further_interaction: finalResponse.message,
            result: 'executed'
          }
        });

        return res.json({
          success: true,
          response: finalResponse.message || 'Here are your events',
          executed: true,
          result: toolResult,
          conversationHistory
        });
      }

      // Add assistant response and tool result to history (even for confirmation)
      conversationHistory.push({
        role: 'assistant',
        content: null,
        tool_calls: llmResponse.toolCalls
      });

      conversationHistory.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify({ status: 'pending_confirmation', action: { type: name, ...params } })
      });

      console.log('🔍 DEBUG - Updated conversation history after tool call:', JSON.stringify(conversationHistory, null, 2));

      // For mutating actions, return preview for confirmation
      // Calendar is required in tool calls, so it's always in params
      const actionPreview = {
        type: name,
        ...params
      };

        // Smart defaults for create events
        if (name === 'create_calendar_event') {
          // Validate required attendees
          if (!params.attendees || params.attendees.length === 0) {
            return res.json({
              success: true,
              response: "Who should attend this meeting?",
              needsClarification: true,
              conversationHistory
            });
          }

          // Validate email addresses
          const invalidEmails = params.attendees.filter(attendee => {
            const email = attendee.email;
            return !email || !email.includes('@') || !email.includes('.') || email.length < 5;
          });

          if (invalidEmails.length > 0) {
            return res.json({
              success: true,
              response: "Please provide valid email addresses for all attendees.",
              needsClarification: true,
              conversationHistory
            });
          }

          // If no start time after multiple attempts, use next available hour
          if (!params.startTime) {
            const now = new Date();
            const nextHour = new Date(now);
            nextHour.setHours(now.getHours() + 1, 0, 0, 0);
            actionPreview.startTime = nextHour.toISOString();
          }
          
          // Calculate end time based on duration or default to 30 minutes
          if (!params.endTime && actionPreview.startTime) {
            const startTime = new Date(actionPreview.startTime);
            let durationMinutes = 30; // Default
            
            // If duration is provided in params, use it
            if (params.duration) {
              durationMinutes = parseInt(params.duration) || 30;
            }
            
            const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);
            actionPreview.endTime = endTime.toISOString();
          }
        }

        // For delete and update events, fetch event details for confirmation
        if ((name === 'delete_calendar_event' || name === 'update_calendar_event') && params.eventId) {
          try {
            const token = req.primaryCalendar === 'outlook' ? req.outlookToken : req.googleToken;
            const calendar = getCalendar(token);
            const eventResponse = await calendar.events.get({
              calendarId: 'primary',
              eventId: params.eventId
            });
            
            const event = eventResponse.data;
            actionPreview.eventDetails = {
              summary: event.summary,
              description: event.description,
              start: event.start,
              end: event.end,
              attendees: event.attendees
            };
          } catch (error) {
            console.error(`Failed to fetch event details for ${name}:`, error);
          }
        }

      // Generate confirmation message
      let confirmationMessage = '';
      switch (name) {
        case 'create_calendar_event':
          confirmationMessage = `Create "${params.summary}" on ${new Date(params.startTime).toLocaleString()}?`;
          break;
        case 'update_calendar_event':
          if (actionPreview.eventDetails) {
            const startTime = new Date(actionPreview.eventDetails.start.dateTime || actionPreview.eventDetails.start.date);
            const timeStr = startTime.toLocaleString();
            confirmationMessage = `Update "${actionPreview.eventDetails.summary}" on ${timeStr}?`;
          } else {
            confirmationMessage = `Update event "${params.summary || 'this event'}"?`;
          }
          break;
        case 'delete_calendar_event':
          if (actionPreview.eventDetails) {
            const startTime = new Date(actionPreview.eventDetails.start.dateTime || actionPreview.eventDetails.start.date);
            const timeStr = startTime.toLocaleString();
            confirmationMessage = `Delete "${actionPreview.eventDetails.summary}" on ${timeStr}?`;
          } else {
            confirmationMessage = `Delete "${params.summary || 'this event'}"?`;
          }
          break;
        default:
          confirmationMessage = 'Confirm this action?';
      }

      const confirmationResponse = {
        success: true,
        response: confirmationMessage,
        needsConfirmation: true,
        action: actionPreview,
        conversationHistory
      };

      await recordInteractionLog(req, {
        actionType: name || 'converse',
        calendarType: loggingCalendarType,
        payload: {
          ...toolPayload,
          result: 'pending_confirmation',
          metadata: {
            ...toolPayload.metadata,
            action_preview: actionPreview
          }
        }
      });

      return res.json(confirmationResponse);
    } else {
      // GPT is asking for clarification
      conversationHistory.push({
        role: 'assistant',
        content: llmResponse.message
      });

      await recordInteractionLog(req, {
        actionType: 'ask_to_clarify',
        calendarType: loggingCalendarType,
        payload: {
          modality: inputModality,
          user_instruction: userMessage,
          llm_interaction: llmResponse.message,
          metadata: {
            endpoint: 'voice_command',
            request_id: req.requestId,
            latency_ms: llmLatencyMs
          }
        }
      });

      return res.json({
        success: true,
        response: llmResponse.message,
        needsClarification: true,
        conversationHistory
      });
    }
  } catch (error) {
    console.error('Voice command error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/voice/stream - Process voice command with SSE (progressive updates)
// Note: authAndRateLimit middleware (applied at /api level) already extracts tokens and sets req.googleToken, req.outlookToken, req.primaryCalendar
router.post('/stream', upload.single('audio'), async (req, res) => {
  try {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    console.log('📥 /stream endpoint called');
    console.log('📥 Has file:', !!req.file);
    console.log('📥 Body keys:', Object.keys(req.body || {}));
    console.log('📥 Body text:', req.body?.text);
    console.log('📥 Body history:', req.body?.history ? 'present' : 'missing');

    let conversationHistory = [];
    let inputModality = 'voice';
    const loggingCalendarType = req.query.type || 'google';

    // Parse conversation history if provided
    if (req.body?.history) {
      try {
        conversationHistory = JSON.parse(req.body.history);
        console.log('📥 Parsed history, length:', conversationHistory.length);
      } catch (e) {
        console.error('Failed to parse history:', e);
      }
    }

    // Step 1: Transcribe audio or get text input
    let userMessage;
    
    if (req.file) {
      // Log audio file size
      console.log(`Received audio file: ${req.file.originalname}, size: ${req.file.size} bytes`);
      // Reject audio larger than 1.5 MB
      const MAX_AUDIO_BYTES = 250 * 1024; // 1 KB limit
      if (req.file.size && req.file.size > MAX_AUDIO_BYTES) {
        res.write(`data: ${JSON.stringify({
          type: 'response',
          response: "I'm sorry, I couldn't keep track of what you're saying. Could you summarize ? For longer commands, you can also consider upgrading to our Kalendra Plus plan !"
        })}\n\n`);
        res.end();
        return;
      }

      const transcription = await transcribeAudio(req.file.buffer, req.file.originalname);
      
      if (!transcription.success) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: transcription.error })}\n\n`);
        res.end();
        return;
      }

      userMessage = transcription.text;
      inputModality = 'voice';
      
      // Send transcription event
      res.write(`data: ${JSON.stringify({ type: 'transcription', text: userMessage })}\n\n`);
    } else if (req.body?.text) {
      // Handle text input (for text chat)
      userMessage = req.body.text;
      inputModality = 'text';
      console.log(`✅ Received text input: ${userMessage}`);
    } else {
      console.log('❌ No audio file or text input found');
      console.log('❌ req.body:', req.body);
      console.log('❌ req.body?.text:', req.body?.text);
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Either audio file or text input required' })}\n\n`);
      res.end();
      return;
    }

    // Step 2: Fetch context (today's meetings + recent contacts)
    let contextInfo = '';
    
    try {
      const googleToken = req.googleToken;
      const outlookToken = req.outlookToken;
      const primaryCalendar = req.primaryCalendar;

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      
      const todayEvents = await getEvents(googleToken, outlookToken, primaryCalendar, {
        timeMin: todayStart.toISOString(),
        timeMax: todayEnd.toISOString()
      }, req.user?.email);

      if (todayEvents.success && todayEvents.events.length > 0) {
        const meetingsList = todayEvents.events
          .map(e => {
            const start = new Date(e.start.dateTime || e.start.date);
            const time = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            return `${time} - ${e.summary} (ID: ${e.id})`;
          })
          .join(', ');
        contextInfo += `Today's meetings: ${meetingsList}\n`;
      }

      // Fetch recent contacts (last 2 months)
      const twoMonthsAgo = new Date();
      twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
      
      const recentEvents = await getEvents(googleToken, outlookToken, primaryCalendar, {
        timeMin: twoMonthsAgo.toISOString(),
        maxResults: 50
      }, req.user?.email);

      if (recentEvents.success) {
        // Log the full context of past 2 months' meetings        
        const contactMap = new Map(); // email -> {name, email}
        recentEvents.events.forEach(event => {
          if (event.attendees) {
            event.attendees.forEach(a => {
              if (a.email && a.displayName) {
                contactMap.set(a.email, {
                  name: a.displayName,
                  email: a.email
                });
              }
            });
          }
        });
        
        if (contactMap.size > 0) {
          const contactsList = Array.from(contactMap.values())
            .map(c => `${c.name} (${c.email})`)
            .join(', ');
          contextInfo += `Recent contacts: ${contactsList}`;
        }
      }
    } catch (error) {
      console.error('Failed to fetch context:', error);
    }

    // Step 3: Process with LLM
    conversationHistory.push({
      role: 'user',
      content: userMessage
    });

    console.log('🔍 DEBUG - Transcribed text:', userMessage);
    console.log('🔍 DEBUG - Input modality:', inputModality);
    console.log('🔍 DEBUG - Conversation history before LLM:', JSON.stringify(conversationHistory, null, 2));
    console.log('🔍 DEBUG - Context info:', contextInfo);

    // Extract timezone and timestamp information from headers
    const timezoneInfo = {
      deviceTimezone: req.headers['x-device-timezone'],
      timezoneOffset: req.headers['x-device-timezone-offset'],
      deviceTimestamp: req.headers['x-device-timestamp']
    };

    const llmStartTime = Date.now();
    const llmResponse = await processWithLLM(conversationHistory, contextInfo, timezoneInfo, inputModality, req.primaryCalendar);
    const llmLatencyMs = Date.now() - llmStartTime;

    if (!llmResponse.success) {
      console.log('❌ DEBUG - LLM response failed:', llmResponse.error);
      res.write(`data: ${JSON.stringify({ type: 'error', error: llmResponse.error })}\n\n`);
      res.end();
      return;
    }

    console.log('✅ DEBUG - LLM response success:', JSON.stringify(llmResponse, null, 2));

    // Step 4: Send result
    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      const toolCall = llmResponse.toolCalls[0];
      const { name, arguments: args } = toolCall.function;
      const params = JSON.parse(args);

      const toolPayload = {
        modality: inputModality,
        user_instruction: userMessage,
        llm_interaction: llmResponse.message,
        tool_call: {
          name,
          arguments: params
        },
        metadata: {
          endpoint: 'voice_stream',
          request_id: req.requestId,
          latency_ms: llmLatencyMs
        }
      };

      // Read-only action - execute and check if followed by mutating action
      if (name === 'list_calendar_events' || name === 'list_tasks') {
        const toolResult = await executeTool(
          toolCall,
          req.googleToken,
          req.outlookToken,
          req.primaryCalendar,
          req.user?.email
        );

        conversationHistory.push({
          role: 'assistant',
          content: null,
          tool_calls: llmResponse.toolCalls
        });

        conversationHistory.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult)
        });

        // Get LLM's next response to see if it wants to do a mutating action
        const nextLlmStart = Date.now();
        const nextLlmResponse = await processWithLLM(conversationHistory, contextInfo, timezoneInfo, inputModality);
        const nextLlmLatencyMs = Date.now() - nextLlmStart;

        // If LLM wants to do a mutating action next, skip sending list result to user
        if (nextLlmResponse.toolCalls && nextLlmResponse.toolCalls.length > 0) {
          const nextToolCall = nextLlmResponse.toolCalls[0];
          const nextName = nextToolCall.function.name;
          
          // If next action is mutating, continue to that instead of sending list result
          if (nextName === 'create_calendar_event' || nextName === 'delete_calendar_event' || nextName === 'update_calendar_event' ||
              nextName === 'create_task' || nextName === 'delete_task' || nextName === 'update_task') {
            console.log(`🔄 List followed by ${nextName}, skipping list response to user`);
            
            // Update conversation history with next tool call
            conversationHistory.push({
              role: 'assistant',
              content: null,
              tool_calls: nextLlmResponse.toolCalls
            });

            // Process the mutating action
            const nextParams = JSON.parse(nextToolCall.function.arguments);
            const nextToolPayload = {
              modality: inputModality,
              user_instruction: userMessage,
              llm_interaction: nextLlmResponse.message,
              tool_call: {
                name: nextName,
                arguments: nextParams
              },
              metadata: {
                endpoint: 'voice_stream',
                request_id: req.requestId,
                latency_ms: nextLlmLatencyMs
              }
            };
            
            conversationHistory.push({
              role: 'tool',
              tool_call_id: nextToolCall.id,
              content: JSON.stringify({ status: 'pending_confirmation', action: { type: nextName, ...nextParams } })
            });

            // Now handle the mutating action confirmation (reuse existing logic below)
            // Calendar is required in tool calls, so it's always in nextParams
            const actionPreview = {
              type: nextName,
              ...nextParams
            };

        // For delete and update events, fetch event details for confirmation
        if ((nextName === 'delete_calendar_event' || nextName === 'update_calendar_event') && nextParams.eventId) {
          try {
            const primaryCalendar = req.primaryCalendar || 'google';
            const token = primaryCalendar === 'outlook' ? req.outlookToken : req.googleToken;
            
            if (primaryCalendar === 'outlook') {
              // Fetch event from Outlook using Microsoft Graph API
              const response = await fetch(`https://graph.microsoft.com/v1.0/me/calendar/events/${nextParams.eventId}`, {
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json'
                }
              });
              
              if (response.ok) {
                const graphEvent = await response.json();
                actionPreview.eventDetails = {
                  summary: graphEvent.subject || '',
                  description: graphEvent.body?.content || '',
                  start: {
                    dateTime: graphEvent.start?.dateTime,
                    date: graphEvent.start?.date,
                    timeZone: graphEvent.start?.timeZone || 'UTC'
                  },
                  end: {
                    dateTime: graphEvent.end?.dateTime,
                    date: graphEvent.end?.date,
                    timeZone: graphEvent.end?.timeZone || 'UTC'
                  },
                  attendees: (graphEvent.attendees || []).map(a => ({
                    email: a.emailAddress?.address,
                    displayName: a.emailAddress?.name
                  }))
                };
              }
            } else {
              // Fetch event from Google Calendar
              const calendar = getCalendar(token);
              const eventResponse = await calendar.events.get({
                calendarId: 'primary',
                eventId: nextParams.eventId
              });
              
              const event = eventResponse.data;
              actionPreview.eventDetails = {
                summary: event.summary,
                description: event.description,
                start: event.start,
                end: event.end,
                attendees: event.attendees
              };
            }
          } catch (error) {
            console.error(`Failed to fetch event details for ${nextName}:`, error);
          }
        }

        // For delete and update tasks, fetch task details for confirmation
        if ((nextName === 'delete_task' || nextName === 'update_task') && nextParams.taskId) {
          try {
            const tasksResult = await getTasks(req.googleToken, req.outlookToken, req.primaryCalendar, {}, req.user?.email);
            
            if (tasksResult.success && tasksResult.tasks) {
              const task = tasksResult.tasks.find(t => t.id === nextParams.taskId);
              if (task) {
                actionPreview.taskDetails = {
                  title: task.summary || task.title || '',
                  notes: task.description || task.notes || '',
                  due: task.start?.date || task.start?.dateTime || task.due || null
                };
              }
            }
          } catch (error) {
            console.error(`Failed to fetch task details for ${nextName}:`, error);
          }
        }

        // Check for conflicts when creating or updating calendar events
        // Only check conflicts if time is being changed (startTime/endTime provided)
        if (nextName === 'create_calendar_event' || (nextName === 'update_calendar_event' && (nextParams.startTime || nextParams.endTime))) {
          const startTime = actionPreview.startTime;
          const endTime = actionPreview.endTime;
          const excludeEventId = nextName === 'update_calendar_event' ? nextParams.eventId : null;
          
          if (startTime && endTime) {
            try {
              const conflict = await checkMeetingConflict(
                req.googleToken,
                req.outlookToken,
                nextParams.calendar || req.primaryCalendar,
                startTime,
                endTime,
                excludeEventId,
                req.user?.email
              );
              actionPreview.conflict = conflict;
            } catch (error) {
              console.error('Error checking meeting conflict:', error);
              actionPreview.conflict = null;
            }
          } else {
            actionPreview.conflict = null;
          }
        } else {
          actionPreview.conflict = null;
        }

            let confirmationMessage = '';
            switch (nextName) {
              case 'create_calendar_event':
                const createTimeStr = formatTimeWithUserTimezone(nextParams.startTime, req);
                confirmationMessage = `Create "${nextParams.summary}" on ${createTimeStr}?`;
                break;
              case 'update_calendar_event':
                if (actionPreview.eventDetails) {
                  const updateTimeStr = formatTimeWithUserTimezone(
                    actionPreview.eventDetails.start.dateTime || actionPreview.eventDetails.start.date, 
                    req
                  );
                  confirmationMessage = `Update "${actionPreview.eventDetails.summary}" on ${updateTimeStr}?`;
                } else {
                  confirmationMessage = `Update event "${nextParams.summary || 'this event'}"?`;
                }
                break;
              case 'delete_calendar_event':
                if (actionPreview.eventDetails) {
                  const deleteTimeStr = formatTimeWithUserTimezone(
                    actionPreview.eventDetails.start.dateTime || actionPreview.eventDetails.start.date, 
                    req
                  );
                  confirmationMessage = `Delete "${actionPreview.eventDetails.summary}" on ${deleteTimeStr}?`;
                } else {
                  confirmationMessage = `Delete "${nextParams.summary || 'this event'}"?`;
                }
                break;
              case 'create_task':
                const dueDateStr = nextParams.due ? formatTimeWithUserTimezone(nextParams.due, req) : null;
                if (dueDateStr) {
                  confirmationMessage = `Create task "${nextParams.title}" due ${dueDateStr}?`;
                } else {
                  confirmationMessage = `Create task "${nextParams.title}"?`;
                }
                break;
              case 'update_task':
                if (actionPreview.taskDetails) {
                  confirmationMessage = `Update task "${actionPreview.taskDetails.title}"?`;
                } else {
                  confirmationMessage = `Update task "${nextParams.title || 'this task'}"?`;
                }
                break;
              case 'delete_task':
                if (actionPreview.taskDetails) {
                  confirmationMessage = `Delete task "${actionPreview.taskDetails.title}"?`;
                } else {
                  confirmationMessage = `Delete task "${nextParams.title || 'this task'}"?`;
                }
                break;
              default:
                confirmationMessage = 'Confirm this action?';
            }

            const confirmationResponse = {
              type: 'response',
              response: confirmationMessage,
              needsConfirmation: true,
              action: actionPreview
            };
            
            console.log('📤 STREAM API RESPONSE (confirmation after list):');
            console.log(JSON.stringify(confirmationResponse, null, 2));
            
            res.write(`data: ${JSON.stringify(confirmationResponse)}\n\n`);
            await recordInteractionLog(req, {
              actionType: nextName || 'converse',
              calendarType: loggingCalendarType,
              payload: {
                ...nextToolPayload,
                result: 'pending_confirmation',
                metadata: {
                  ...nextToolPayload.metadata,
                  action_preview: actionPreview
                }
              }
            });
            res.end();
            return;
          }
        }

        // If no mutating action follows, send list result to user
        const streamResponse = {
          type: 'response',
          response: nextLlmResponse.message || (name === 'list_tasks' ? 'Here are your tasks' : 'Here are your events'),
          executed: true,
          result: toolResult
        };
        
        console.log(`📤 STREAM API RESPONSE (${name}):`);
        console.log(JSON.stringify(streamResponse, null, 2));

        res.write(`data: ${JSON.stringify(streamResponse)}\n\n`);
        await recordInteractionLog(req, {
          actionType: name || 'converse',
          calendarType: loggingCalendarType,
          payload: {
            ...toolPayload,
            llm_interaction: nextLlmResponse.message,
            result: 'executed',
            metadata: {
              ...toolPayload.metadata,
              latency_ms: nextLlmLatencyMs
            }
          }
        });
      } else {
        // Add assistant response and tool result to history (even for confirmation)
        conversationHistory.push({
          role: 'assistant',
          content: null,
          tool_calls: llmResponse.toolCalls
        });

        conversationHistory.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ status: 'pending_confirmation', action: { type: name, ...params } })
        });

        console.log('🔍 DEBUG - Updated conversation history after tool call (SSE):', JSON.stringify(conversationHistory, null, 2));

        // Mutating action - request confirmation
        // Calendar is required in tool calls, so it's always in params
        const actionPreview = {
          type: name,
          ...params
        };

        // Smart defaults for create events
        if (name === 'create_calendar_event') {
          // Validate required attendees
          if (!params.attendees || params.attendees.length === 0) {
            res.write(`data: ${JSON.stringify({
              type: 'response',
              response: "Who should attend this meeting?",
              needsClarification: true
            })}\n\n`);
            res.end();
            return;
          }

          // Validate email addresses
          const invalidEmails = params.attendees.filter(attendee => {
            const email = attendee.email;
            return !email || !email.includes('@') || !email.includes('.') || email.length < 5;
          });

          if (invalidEmails.length > 0) {
            res.write(`data: ${JSON.stringify({
              type: 'response',
              response: "Please provide valid email addresses for all attendees.",
              needsClarification: true
            })}\n\n`);
            res.end();
            return;
          }

          // If no start time after multiple attempts, use next available hour
          if (!params.startTime) {
            const now = new Date();
            const nextHour = new Date(now);
            nextHour.setHours(now.getHours() + 1, 0, 0, 0);
            actionPreview.startTime = nextHour.toISOString();
          }
          
          // Calculate end time based on duration or default to 30 minutes
          if (!params.endTime && actionPreview.startTime) {
            const startTime = new Date(actionPreview.startTime);
            let durationMinutes = 30; // Default
            
            // If duration is provided in params, use it
            if (params.duration) {
              durationMinutes = parseInt(params.duration) || 30;
            }
            
            const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);
            actionPreview.endTime = endTime.toISOString();
          }
        }

        // For delete and update events, fetch event details for confirmation
        if ((name === 'delete_calendar_event' || name === 'update_calendar_event') && params.eventId) {
          try {
            const primaryCalendar = req.primaryCalendar || 'google';
            const token = primaryCalendar === 'outlook' ? req.outlookToken : req.googleToken;
            
            if (primaryCalendar === 'outlook') {
              // Fetch event from Outlook using Microsoft Graph API
              const response = await fetch(`https://graph.microsoft.com/v1.0/me/calendar/events/${params.eventId}`, {
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json'
                }
              });
              
              if (response.ok) {
                const graphEvent = await response.json();
                actionPreview.eventDetails = {
                  summary: graphEvent.subject || '',
                  description: graphEvent.body?.content || '',
                  start: {
                    dateTime: graphEvent.start?.dateTime,
                    date: graphEvent.start?.date,
                    timeZone: graphEvent.start?.timeZone || 'UTC'
                  },
                  end: {
                    dateTime: graphEvent.end?.dateTime,
                    date: graphEvent.end?.date,
                    timeZone: graphEvent.end?.timeZone || 'UTC'
                  },
                  attendees: (graphEvent.attendees || []).map(a => ({
                    email: a.emailAddress?.address,
                    displayName: a.emailAddress?.name
                  }))
                };
              }
            } else {
              // Fetch event from Google Calendar
              const calendar = getCalendar(token);
              const eventResponse = await calendar.events.get({
                calendarId: 'primary',
                eventId: params.eventId
              });
              
              const event = eventResponse.data;
              actionPreview.eventDetails = {
                summary: event.summary,
                description: event.description,
                start: event.start,
                end: event.end,
                attendees: event.attendees
              };
            }
          } catch (error) {
            console.error(`Failed to fetch event details for ${name}:`, error);
          }
        }

        // For delete and update tasks, fetch task details for confirmation
        if ((name === 'delete_task' || name === 'update_task') && params.taskId) {
          try {
            const tasksResult = await getTasks(req.googleToken, req.outlookToken, req.primaryCalendar, {}, req.user?.email);
            
            if (tasksResult.success && tasksResult.tasks) {
              const task = tasksResult.tasks.find(t => t.id === params.taskId);
              if (task) {
                actionPreview.taskDetails = {
                  title: task.summary || task.title || '',
                  notes: task.description || task.notes || '',
                  due: task.start?.date || task.start?.dateTime || task.due || null
                };
              }
            }
          } catch (error) {
            console.error(`Failed to fetch task details for ${name}:`, error);
          }
        }

        // Check for conflicts when creating or updating calendar events
        // Only check conflicts if time is being changed (startTime/endTime provided)
        if (name === 'create_calendar_event' || (name === 'update_calendar_event' && (params.startTime || params.endTime))) {
          const startTime = actionPreview.startTime;
          const endTime = actionPreview.endTime;
          const excludeEventId = name === 'update_calendar_event' ? params.eventId : null;
          
          if (startTime && endTime) {
            try {
              const conflict = await checkMeetingConflict(
                req.googleToken,
                req.outlookToken,
                params.calendar || req.primaryCalendar,
                startTime,
                endTime,
                excludeEventId,
                req.user?.email
              );
              actionPreview.conflict = conflict;
            } catch (error) {
              console.error('Error checking meeting conflict:', error);
              actionPreview.conflict = null;
            }
          } else {
            actionPreview.conflict = null;
          }
        } else {
          actionPreview.conflict = null;
        }

        let confirmationMessage = '';
        switch (name) {
          case 'create_calendar_event':
            const createTimeStr = formatTimeWithUserTimezone(params.startTime, req);
            confirmationMessage = `Create "${params.summary}" on ${createTimeStr}?`;
            break;
          case 'update_calendar_event':
            if (actionPreview.eventDetails) {
              const updateTimeStr = formatTimeWithUserTimezone(
                actionPreview.eventDetails.start.dateTime || actionPreview.eventDetails.start.date, 
                req
              );
              confirmationMessage = `Update "${actionPreview.eventDetails.summary}" on ${updateTimeStr}?`;
            } else {
              confirmationMessage = `Update event "${params.summary || 'this event'}"?`;
            }
            break;
        case 'delete_calendar_event':
          if (actionPreview.eventDetails) {
            const deleteTimeStr = formatTimeWithUserTimezone(
              actionPreview.eventDetails.start.dateTime || actionPreview.eventDetails.start.date, 
              req
            );
            confirmationMessage = `Delete "${actionPreview.eventDetails.summary}" on ${deleteTimeStr}?`;
          } else {
            confirmationMessage = `Delete "${params.summary || 'this event'}"?`;
          }
          break;
          case 'create_task':
            const dueDateStr = params.due ? formatTimeWithUserTimezone(params.due, req) : null;
            if (dueDateStr) {
              confirmationMessage = `Create task "${params.title}" due ${dueDateStr}?`;
            } else {
              confirmationMessage = `Create task "${params.title}"?`;
            }
            break;
          case 'update_task':
            if (actionPreview.taskDetails) {
              confirmationMessage = `Update task "${actionPreview.taskDetails.title}"?`;
            } else {
              confirmationMessage = `Update task "${params.title || 'this task'}"?`;
            }
            break;
          case 'delete_task':
            if (actionPreview.taskDetails) {
              confirmationMessage = `Delete task "${actionPreview.taskDetails.title}"?`;
            } else {
              confirmationMessage = `Delete task "${params.title || 'this task'}"?`;
            }
            break;
          default:
            confirmationMessage = 'Confirm this action?';
        }

        const confirmationResponse = {
          type: 'response',
          response: confirmationMessage,
          needsConfirmation: true,
          action: actionPreview
        };
        
        console.log('📤 STREAM API RESPONSE (confirmation needed):');
        console.log(JSON.stringify(confirmationResponse, null, 2));

        res.write(`data: ${JSON.stringify(confirmationResponse)}\n\n`);
        await recordInteractionLog(req, {
          actionType: name || 'converse',
          calendarType: loggingCalendarType,
          payload: {
            ...toolPayload,
            result: 'pending_confirmation',
            metadata: {
              ...toolPayload.metadata,
              action_preview: actionPreview
            }
          }
        });
      }
    } else {
      // Clarification needed
      conversationHistory.push({
        role: 'assistant',
        content: llmResponse.message
      });

      const clarificationResponse = {
        type: 'response',
        response: llmResponse.message,
        needsClarification: true
      };
      
      console.log('📤 STREAM API RESPONSE (clarification needed):');
      console.log(JSON.stringify(clarificationResponse, null, 2));

      res.write(`data: ${JSON.stringify(clarificationResponse)}\n\n`);
      await recordInteractionLog(req, {
        actionType: 'ask_to_clarify',
        calendarType: loggingCalendarType,
        payload: {
          modality: inputModality,
          user_instruction: userMessage,
          llm_interaction: llmResponse.message,
          metadata: {
            endpoint: 'voice_stream',
            request_id: req.requestId,
            latency_ms: llmLatencyMs
          }
        }
      });
    }

    res.end();
  } catch (error) {
    console.error('Voice stream error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

// POST /api/voice/execute - Execute a confirmed action
// Note: authAndRateLimit middleware (applied at /api level) already extracts tokens and sets req.googleToken, req.outlookToken, req.primaryCalendar
router.post('/execute', async (req, res) => {
  try {
    const { action, confirmed } = req.body;
    const loggingCalendarType = req.query.type || 'google';
    const requestModality = req.body?.modality || null;

    console.log('📥 EXECUTE API REQUEST:');
    console.log(JSON.stringify({ action, confirmed }, null, 2));

    if (!action) {
      return res.status(400).json({
        success: false,
        error: 'Action details required'
      });
    }

    // User cancelled
    if (!confirmed) {
      const cancelResponse = {
        success: true,
        response: 'Action cancelled',
        cancelled: true
      };
      
      console.log('📤 EXECUTE API RESPONSE (cancelled):');
      console.log(JSON.stringify(cancelResponse, null, 2));

      await recordInteractionLog(req, {
        actionType: 'cancel',
        calendarType: loggingCalendarType,
        payload: {
          modality: requestModality,
          metadata: {
            endpoint: 'execute',
            request_id: req.requestId,
            action
          }
        }
      });
      
      return res.json(cancelResponse);
    }

    // Validate action type
    const validActions = ['create_calendar_event', 'update_calendar_event', 'delete_calendar_event', 'create_task', 'update_task', 'delete_task'];
    if (!validActions.includes(action.type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid action type'
      });
    }

    // Execute the action
    let result;
    switch (action.type) {
      case 'create_calendar_event':
        // Validate email addresses
        const invalidEmails = action.attendees.filter(attendee => {
          const email = attendee.email;
          return !email || !email.includes('@') || !email.includes('.') || email.length < 5;
        });

        if (invalidEmails.length > 0) {
          return res.status(400).json({
            success: false,
            error: 'Please provide valid email addresses for all attendees'
          });
        }

        // Smart defaults for start time and end time
        let startTime = action.startTime;
        let endTime = action.endTime;
        
        // If no start time, use next available hour
        if (!startTime) {
          const now = new Date();
          const nextHour = new Date(now);
          nextHour.setHours(now.getHours() + 1, 0, 0, 0);
          startTime = nextHour.toISOString();
        }
        
        // Calculate end time based on duration or default to 30 minutes
        if (!endTime && startTime) {
          const start = new Date(startTime);
          let durationMinutes = 30; // Default
          
          // If duration is provided, use it
          if (action.duration) {
            durationMinutes = parseInt(action.duration) || 30;
          }
          
          endTime = new Date(start.getTime() + durationMinutes * 60 * 1000).toISOString();
        }
        
        result = await createEvent(req.googleToken, req.outlookToken, action.calendar, {
          summary: action.summary,
          startTime: startTime,
          endTime: endTime,
          description: action.description,
          attendees: action.attendees
        });
        break;

      case 'update_calendar_event':
        // Validate that at least one field is being updated
        const hasUpdateFields = action.summary || action.startTime || action.endTime || 
                               action.description !== undefined || action.attendees;
        
        if (!hasUpdateFields) {
          return res.status(400).json({
            success: false,
            error: 'At least one field must be provided for update (summary, startTime, endTime, description, or attendees)'
          });
        }

        // Validate email addresses if attendees are provided
        if (action.attendees && action.attendees.length > 0) {
          const invalidUpdateEmails = action.attendees.filter(attendee => {
            const email = attendee.email;
            return !email || !email.includes('@') || !email.includes('.') || email.length < 5;
          });

          if (invalidUpdateEmails.length > 0) {
            return res.status(400).json({
              success: false,
              error: 'Please provide valid email addresses for all attendees'
            });
          }
        }

        result = await updateEvent(req.googleToken, req.outlookToken, action.calendar, action.eventId, {
          summary: action.summary,
          startTime: action.startTime,
          endTime: action.endTime,
          description: action.description,
          attendees: action.attendees
        });
        break;

      case 'delete_calendar_event':
        result = await deleteEvent(req.googleToken, req.outlookToken, action.calendar, action.eventId);
        break;

      case 'create_task':
        result = await createTask(req.googleToken, req.outlookToken, action.calendar, {
          title: action.title,
          notes: action.notes,
          due: action.due
        });
        break;

      case 'update_task':
        result = await updateTask(req.googleToken, req.outlookToken, action.calendar, action.taskId, {
          title: action.title,
          notes: action.notes,
          due: action.due
        });
        break;

      case 'delete_task':
        result = await deleteTask(req.googleToken, req.outlookToken, action.calendar, action.taskId);
        break;
    }

    if (result.success) {
      const executeResponse = {
        success: true,
        response: 'Action completed successfully',
        result
      };
      
      console.log('📤 EXECUTE API RESPONSE (success):');
      console.log(JSON.stringify(executeResponse, null, 2));

      await recordInteractionLog(req, {
        actionType: 'approve',
        calendarType: action?.calendarType || loggingCalendarType,
        payload: {
          modality: requestModality,
          metadata: {
            endpoint: 'execute',
            request_id: req.requestId,
            action
          }
        }
      });
      
      return res.json(executeResponse);
    } else {
      return res.status(500).json(result);
    }
  } catch (error) {
    console.error('Execute action error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/voice/check - Check if action needs confirmation (non-SSE)
// Note: authAndRateLimit middleware (applied at /api level) already extracts tokens and sets req.googleToken, req.outlookToken, req.primaryCalendar
router.post('/widget', upload.single('audio'), async (req, res) => {
  console.log('🔍 DEBUG - Widget API REQUEST:');
  try {
    let userMessage;
    let conversationHistory = [];

    // Parse conversation history if provided
    if (req.body.history) {
      try {
        conversationHistory = JSON.parse(req.body.history);
      } catch (e) {
        console.error('Failed to parse history:', e);
      }
    }

    // Handle audio input
    if (req.file) {
      const transcription = await transcribeAudio(req.file.buffer, req.file.originalname);
      
      if (!transcription.success) {
        return res.status(500).json(transcription);
      }
      
      userMessage = transcription.text;
    } else if (req.body.text) {
      userMessage = req.body.text;
    } else {
      return res.status(400).json({ success: false, error: 'No audio or text input provided' });
    }

    // Add user message to conversation
    conversationHistory.push({ role: 'user', content: userMessage });

    // Process with LLM - loop up to 3 times to find mutating action
    let llmResponse;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;
      llmResponse = await processWithLLM(conversationHistory, {}, {}, 'voice', req.primaryCalendar);

      if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
        const toolCall = llmResponse.toolCalls[0];
        const { name, arguments: args } = toolCall.function;
        const params = JSON.parse(args);

        // Check if it's a mutating action that needs confirmation
        if (name === 'create_calendar_event' || name === 'delete_calendar_event' || name === 'update_calendar_event' ||
            name === 'create_task' || name === 'delete_task' || name === 'update_task') {
          // Calendar is required in tool calls, so it's always in params
          const actionPreview = {
            type: name,
            ...params
          };

          // For delete and update events, fetch event details for confirmation
          if ((name === 'delete_calendar_event' || name === 'update_calendar_event') && params.eventId) {
            try {
              const token = req.primaryCalendar === 'outlook' ? req.outlookToken : req.googleToken;
              const calendar = getCalendar(token);
              const eventResponse = await calendar.events.get({
                calendarId: 'primary',
                eventId: params.eventId
              });
              
              const event = eventResponse.data;
              actionPreview.eventDetails = {
                summary: event.summary,
                description: event.description,
                start: event.start,
                end: event.end,
                attendees: event.attendees
              };
            } catch (error) {
              console.error(`Failed to fetch event details for ${name}:`, error);
            }
          }

          return res.json({
            success: true,
            needsConfirmation: true,
            action: actionPreview
          });
        }

      // If it's a read-only action, execute it and continue
      if (name === 'list_calendar_events' || name === 'list_tasks') {
          try {
            const toolResult = await executeTool(
              toolCall,
              req.googleToken,
              req.outlookToken,
              req.primaryCalendar,
              req.user?.email
            );
            
            // Add assistant response and tool result to history
            conversationHistory.push({
              role: 'assistant',
              content: null,
              tool_calls: llmResponse.toolCalls
            });

            conversationHistory.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(toolResult)
            });
          } catch (error) {
            console.error('Tool execution error:', error);
            break;
          }
        }
      } else {
        // No tool calls, break the loop
        break;
      }
    }

    // No mutating action found after max attempts
    return res.json({
      success: true,
      needsConfirmation: null
    });

  } catch (error) {
    console.error('Check action error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;

