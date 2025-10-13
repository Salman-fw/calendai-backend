import OpenAI from 'openai';

let openai = null;

function getOpenAI() {
  if (!openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    
    if (!apiKey || apiKey === 'your_openai_api_key_here') {
      console.error('⚠️  OPENAI_API_KEY not configured for LLM service');
      throw new Error('OpenAI API key not configured');
    }
    
    openai = new OpenAI({ apiKey });
    console.log('✅ OpenAI LLM service initialized successfully');
  }
  return openai;
}

// Define available functions for GPT
const tools = [
  {
    type: 'function',
    function: {
      name: 'list_calendar_events',
      description: 'Get calendar events for a specified time range or search query',
      parameters: {
        type: 'object',
        properties: {
          timeMin: {
            type: 'string',
            description: 'Start datetime in ISO 8601 format (e.g., 2025-10-15T00:00:00Z)'
          },
          timeMax: {
            type: 'string',
            description: 'End datetime in ISO 8601 format'
          },
          q: {
            type: 'string',
            description: 'Search query to filter events by summary or description'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_calendar_event',
      description: 'Create a new calendar event',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Event title/summary'
          },
          startTime: {
            type: 'string',
            description: 'Event start datetime in ISO 8601 format'
          },
          endTime: {
            type: 'string',
            description: 'Event end datetime in ISO 8601 format'
          },
          description: {
            type: 'string',
            description: 'Event description (optional)'
          },
          attendees: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                email: { type: 'string' }
              }
            },
            description: 'List of attendee emails (optional)'
          }
        },
        required: ['summary', 'startTime', 'endTime']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_calendar_event',
      description: 'Update an existing calendar event',
      parameters: {
        type: 'object',
        properties: {
          eventId: {
            type: 'string',
            description: 'ID of the event to update'
          },
          summary: {
            type: 'string',
            description: 'Updated event title'
          },
          startTime: {
            type: 'string',
            description: 'Updated start datetime in ISO 8601'
          },
          endTime: {
            type: 'string',
            description: 'Updated end datetime in ISO 8601'
          },
          description: {
            type: 'string',
            description: 'Updated description'
          }
        },
        required: ['eventId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_calendar_event',
      description: 'Delete a calendar event',
      parameters: {
        type: 'object',
        properties: {
          eventId: {
            type: 'string',
            description: 'ID of the event to delete'
          }
        },
        required: ['eventId']
      }
    }
  }
];

// Process user message with GPT function calling
export async function processWithLLM(messages) {
  try {
    const client = getOpenAI();
    
    // Add system message with context
    const systemMessage = {
      role: 'system',
      content: `You are a helpful calendar assistant. Current datetime: ${new Date().toISOString()}.
      
When users ask about events, help them find, create, update, or delete calendar events.
For time-relative queries like "tomorrow at 3pm", convert to ISO 8601 datetime.
If you need more information (like time, title, etc), ask the user clearly.
Be concise and friendly.`
    };

    const response = await client.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [systemMessage, ...messages],
      tools,
      tool_choice: 'auto'
    });

    const responseMessage = response.choices[0].message;

    return {
      success: true,
      message: responseMessage.content,
      toolCalls: responseMessage.tool_calls || []
    };
  } catch (error) {
    console.error('LLM processing error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

