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

    // Add current user message to history
    conversationHistory.push({
      role: 'user',
      content: userMessage
    });

    // Process with LLM
    const llmResponse = await processWithLLM(conversationHistory);

    if (!llmResponse.success) {
      return res.status(500).json(llmResponse);
    }

    // Check if GPT wants to call a tool
    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      // Execute the first tool call
      const toolCall = llmResponse.toolCalls[0];
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

      // Get final natural language response from GPT
      const finalResponse = await processWithLLM(conversationHistory);

      return res.json({
        success: true,
        response: finalResponse.message || 'Action completed',
        toolUsed: toolCall.function.name,
        result: toolResult,
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

export default router;

