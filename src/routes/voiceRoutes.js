import express from 'express';
import multer from 'multer';
import { transcribeAudio } from '../services/whisperService.js';
import { processWithLLM } from '../services/llmService.js';
import { getEvents, createEvent, updateEvent, deleteEvent } from '../services/calendarService.js';
import { extractToken } from '../middleware/auth.js';

const router = express.Router();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

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
            return `${time} - ${e.summary}`;
          })
          .join(', ');
        contextInfo += `Today's meetings: ${meetingsList}\n`;
      }

      const twoMonthsAgo = new Date();
      twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
      
      const recentEvents = await getEvents(req.accessToken, {
        timeMin: twoMonthsAgo.toISOString(),
        maxResults: 250
      });

      if (recentEvents.success) {
        const emails = new Set();
        recentEvents.events.forEach(event => {
          if (event.attendees) {
            event.attendees.forEach(a => {
              if (a.email) emails.add(a.email);
            });
          }
        });
        
        if (emails.size > 0) {
          contextInfo += `Recent contacts: ${Array.from(emails).join(', ')}`;
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
    const llmResponse = await processWithLLM(conversationHistory, contextInfo);

    if (!llmResponse.success) {
      return res.status(500).json(llmResponse);
    }

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

      // For mutating actions, return preview for confirmation
      const actionPreview = {
        type: name,
        ...params
      };

      // Generate confirmation message
      let confirmationMessage = '';
      switch (name) {
        case 'create_calendar_event':
          confirmationMessage = `Create "${params.summary}" on ${new Date(params.startTime).toLocaleString()}?`;
          break;
        case 'update_calendar_event':
          confirmationMessage = `Update event "${params.summary || 'this event'}"?`;
          break;
        case 'delete_calendar_event':
          confirmationMessage = `Delete this event?`;
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
            return `${time} - ${e.summary}`;
          })
          .join(', ');
        contextInfo += `Today's meetings: ${meetingsList}\n`;
      }

      // Fetch recent contacts (last 2 months)
      const twoMonthsAgo = new Date();
      twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
      
      const recentEvents = await getEvents(req.accessToken, {
        timeMin: twoMonthsAgo.toISOString(),
        maxResults: 100
      });

      if (recentEvents.success) {
        const emails = new Set();
        recentEvents.events.forEach(event => {
          if (event.attendees) {
            event.attendees.forEach(a => {
              if (a.email) emails.add(a.email);
            });
          }
        });
        
        if (emails.size > 0) {
          contextInfo += `Recent contacts: ${Array.from(emails).join(', ')}`;
        }
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

    const llmResponse = await processWithLLM(conversationHistory, contextInfo);

    if (!llmResponse.success) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: llmResponse.error })}\n\n`);
      res.end();
      return;
    }

    // Step 4: Send result
    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      const toolCall = llmResponse.toolCalls[0];
      const { name, arguments: args } = toolCall.function;
      const params = JSON.parse(args);

      // Read-only action - execute immediately
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

        res.write(`data: ${JSON.stringify({
          type: 'response',
          response: finalResponse.message || 'Here are your events',
          executed: true,
          result: toolResult,
          conversationHistory
        })}\n\n`);
      } else {
        // Mutating action - request confirmation
        const actionPreview = {
          type: name,
          ...params
        };

        let confirmationMessage = '';
        switch (name) {
          case 'create_calendar_event':
            confirmationMessage = `Create "${params.summary}" on ${new Date(params.startTime).toLocaleString()}?`;
            break;
          case 'update_calendar_event':
            confirmationMessage = `Update event "${params.summary || 'this event'}"?`;
            break;
          case 'delete_calendar_event':
            confirmationMessage = `Delete this event?`;
            break;
          default:
            confirmationMessage = 'Confirm this action?';
        }

        res.write(`data: ${JSON.stringify({
          type: 'response',
          response: confirmationMessage,
          needsConfirmation: true,
          action: actionPreview,
          conversationHistory
        })}\n\n`);
      }
    } else {
      // Clarification needed
      conversationHistory.push({
        role: 'assistant',
        content: llmResponse.message
      });

      res.write(`data: ${JSON.stringify({
        type: 'response',
        response: llmResponse.message,
        needsClarification: true,
        conversationHistory
      })}\n\n`);
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

    if (!action) {
      return res.status(400).json({
        success: false,
        error: 'Action details required'
      });
    }

    // User cancelled
    if (!confirmed) {
      return res.json({
        success: true,
        response: 'Action cancelled',
        cancelled: true
      });
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
        result = await createEvent(req.accessToken, {
          summary: action.summary,
          startTime: action.startTime,
          endTime: action.endTime,
          description: action.description,
          attendees: action.attendees
        });
        break;

      case 'update_calendar_event':
        result = await updateEvent(req.accessToken, action.eventId, {
          summary: action.summary,
          startTime: action.startTime,
          endTime: action.endTime,
          description: action.description
        });
        break;

      case 'delete_calendar_event':
        result = await deleteEvent(req.accessToken, action.eventId);
        break;
    }

    if (result.success) {
      return res.json({
        success: true,
        response: 'Action completed successfully',
        result
      });
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

export default router;

