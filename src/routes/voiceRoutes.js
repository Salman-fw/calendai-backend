import express from 'express';
import multer from 'multer';
import { transcribeAudio } from '../services/whisperService.js';
import { processWithLLM } from '../services/llmService.js';
import { getEvents, createEvent, updateEvent, deleteEvent, getCalendar } from '../services/calendarService.js';
import { extractToken } from '../middleware/auth.js';

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

// Execute calendar function based on GPT tool call
async function executeTool(toolCall, accessToken) {
  const { name, arguments: args } = toolCall.function;
  const params = JSON.parse(args);

  console.log(`Executing tool: ${name} with params:`, params);

  switch (name) {
    case 'list_calendar_events':
      return await getEvents(accessToken, params);

    case 'create_calendar_event':
      return await createEvent(accessToken, params);

    case 'update_calendar_event':
      return await updateEvent(accessToken, params.eventId, params);

    case 'delete_calendar_event':
      return await deleteEvent(accessToken, params.eventId);

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
    const llmResponse = await processWithLLM(conversationHistory);

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
router.post('/command', extractToken, upload.single('audio'), async (req, res) => {
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

    // Fetch context (today's meetings + recent contacts)
    let contextInfo = '';
    
    try {
      const start = new Date();
      start.setDate(start.getDate() - 1); 
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      
      const events = await getEvents(req.accessToken, {
        timeMin: start.toISOString(),
        timeMax: end.toISOString()
      });

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
      
      const recentEvents = await getEvents(req.accessToken, {
        timeMin: twoMonthsAgo.toISOString(),
        maxResults: 50
      });

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

    const llmResponse = await processWithLLM(conversationHistory, contextInfo, timezoneInfo);

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

      // Check if this is a read-only action (execute immediately)
      if (name === 'list_calendar_events') {
        const toolResult = await executeTool(toolCall, req.accessToken);

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

        const finalResponse = await processWithLLM(conversationHistory);

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
            const calendar = getCalendar(req.accessToken);
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

      return res.json({
        success: true,
        response: confirmationMessage,
        needsConfirmation: true,
        action: actionPreview,
        conversationHistory
      });
    } else {
      // GPT is asking for clarification
      conversationHistory.push({
        role: 'assistant',
        content: llmResponse.message
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
router.post('/stream', extractToken, upload.single('audio'), async (req, res) => {
  try {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    let conversationHistory = [];

    // Parse conversation history if provided
    if (req.body.history) {
      try {
        conversationHistory = JSON.parse(req.body.history);
      } catch (e) {
        console.error('Failed to parse history:', e);
      }
    }

    // Step 1: Transcribe audio
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
      
      // Send transcription event
      res.write(`data: ${JSON.stringify({ type: 'transcription', text: userMessage })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Audio file input required' })}\n\n`);
      res.end();
      return;
    }

    // Step 2: Fetch context (today's meetings + recent contacts)
    let contextInfo = '';
    
    try {
      // Fetch today's events
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      
      const todayEvents = await getEvents(req.accessToken, {
        timeMin: todayStart.toISOString(),
        timeMax: todayEnd.toISOString()
      });

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
      
      const recentEvents = await getEvents(req.accessToken, {
        timeMin: twoMonthsAgo.toISOString(),
        maxResults: 50
      });

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

        console.log('🔍 \n\n\n\n\nDEBUG - Past 2 months meetings context:', JSON.stringify(recentEvents.events, null, 2));

      }
    } catch (error) {
      console.error('Failed to fetch context:', error);
      // Continue without context
    }

    // Step 3: Process with LLM
    conversationHistory.push({
      role: 'user',
      content: userMessage
    });

    console.log('🔍 DEBUG - Transcribed text:', userMessage);
    console.log('🔍 DEBUG - Conversation history before LLM:', JSON.stringify(conversationHistory, null, 2));
    console.log('🔍 DEBUG - Context info:', contextInfo);

    // Extract timezone and timestamp information from headers
    const timezoneInfo = {
      deviceTimezone: req.headers['x-device-timezone'],
      timezoneOffset: req.headers['x-device-timezone-offset'],
      deviceTimestamp: req.headers['x-device-timestamp']
    };

    const llmResponse = await processWithLLM(conversationHistory, contextInfo, timezoneInfo);

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

      // Read-only action - execute and check if followed by mutating action
      if (name === 'list_calendar_events') {
        const toolResult = await executeTool(toolCall, req.accessToken);

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
        const nextLlmResponse = await processWithLLM(conversationHistory, contextInfo, timezoneInfo);

        // If LLM wants to do a mutating action next, skip sending list result to user
        if (nextLlmResponse.toolCalls && nextLlmResponse.toolCalls.length > 0) {
          const nextToolCall = nextLlmResponse.toolCalls[0];
          const nextName = nextToolCall.function.name;
          
          // If next action is mutating, continue to that instead of sending list result
          if (nextName === 'create_calendar_event' || nextName === 'delete_calendar_event' || nextName === 'update_calendar_event') {
            console.log(`🔄 List followed by ${nextName}, skipping list response to user`);
            
            // Update conversation history with next tool call
            conversationHistory.push({
              role: 'assistant',
              content: null,
              tool_calls: nextLlmResponse.toolCalls
            });

            // Process the mutating action
            const nextParams = JSON.parse(nextToolCall.function.arguments);
            
            conversationHistory.push({
              role: 'tool',
              tool_call_id: nextToolCall.id,
              content: JSON.stringify({ status: 'pending_confirmation', action: { type: nextName, ...nextParams } })
            });

            // Now handle the mutating action confirmation (reuse existing logic below)
            const actionPreview = {
              type: nextName,
              ...nextParams
            };

            // For delete and update events, fetch event details for confirmation
            if ((nextName === 'delete_calendar_event' || nextName === 'update_calendar_event') && nextParams.eventId) {
              try {
                const calendar = getCalendar(req.accessToken);
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
              } catch (error) {
                console.error(`Failed to fetch event details for ${nextName}:`, error);
              }
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
            res.end();
            return;
          }
        }

        // If no mutating action follows, send list result to user
        const streamResponse = {
          type: 'response',
          response: nextLlmResponse.message || 'Here are your events',
          executed: true,
          result: toolResult
        };
        
        console.log('📤 STREAM API RESPONSE (list_calendar_events):');
        console.log(JSON.stringify(streamResponse, null, 2));

        res.write(`data: ${JSON.stringify(streamResponse)}\n\n`);
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
            const calendar = getCalendar(req.accessToken);
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
    }

    res.end();
  } catch (error) {
    console.error('Voice stream error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

// POST /api/voice/execute - Execute a confirmed action
router.post('/execute', extractToken, async (req, res) => {
  try {
    const { action, confirmed } = req.body;

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
      
      return res.json(cancelResponse);
    }

    // Validate action type
    const validActions = ['create_calendar_event', 'update_calendar_event', 'delete_calendar_event'];
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
        
        result = await createEvent(req.accessToken, {
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

        result = await updateEvent(req.accessToken, action.eventId, {
          summary: action.summary,
          startTime: action.startTime,
          endTime: action.endTime,
          description: action.description,
          attendees: action.attendees
        });
        break;

      case 'delete_calendar_event':
        result = await deleteEvent(req.accessToken, action.eventId);
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
router.post('/widget', extractToken, upload.single('audio'), async (req, res) => {
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
      llmResponse = await processWithLLM(conversationHistory, {}, {});

      if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
        const toolCall = llmResponse.toolCalls[0];
        const { name, arguments: args } = toolCall.function;
        const params = JSON.parse(args);

        // Check if it's a mutating action that needs confirmation
        if (name === 'create_calendar_event' || name === 'delete_calendar_event' || name === 'update_calendar_event') {
          const actionPreview = {
            type: name,
            ...params
          };

          // For delete and update events, fetch event details for confirmation
          if ((name === 'delete_calendar_event' || name === 'update_calendar_event') && params.eventId) {
            try {
              const calendar = getCalendar(req.accessToken);
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
        if (name === 'list_calendar_events') {
          try {
            const toolResult = await executeTool(toolCall, req.accessToken);
            
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

