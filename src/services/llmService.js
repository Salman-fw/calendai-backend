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
            description: 'Event end datetime in ISO 8601 format. If not provided, defaults to 30 minutes after startTime'
          },
          duration: {
            type: 'number',
            description: 'Meeting duration in minutes (optional). If provided, endTime should be calculated automatically'
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
            description: 'List of attendee emails (REQUIRED - at least one attendee must be specified)',
            minItems: 1
          }
        },
        required: ['summary', 'startTime', 'attendees']
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
          },
          attendees: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                email: { type: 'string' }
              }
            },
            description: 'List of attendee emails (REQUIRED - at least one attendee must be specified)',
            minItems: 1
          }
        },
        required: ['eventId', 'attendees']
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
export async function processWithLLM(messages, contextInfo = '') {
  try {
    const client = getOpenAI();
    
    // Add system message with context
    let systemContent = `You are an ultra-concise calendar assistant. Current datetime: ${new Date().toISOString()}.

Use minimal words.
- "Schedule meeting with John tomorrow 3pm" → Create event immediately
- "Cancel my 3pm" → Delete the 3pm event
- "What's tomorrow?" → List tomorrow's events
- If missing info: Ask ONE short question only

SMART DEFAULTS:
- If user provides start time + duration: Calculate end time automatically
- If user provides start time but no duration: Use 30 minutes default
- If user refuses/unable to provide start time after 2 attempts: Use next available hour as start time
- Always try to extract time from user input first

PARTICIPANT RESOLUTION:
- If user mentions a name that matches multiple contacts, ask for clarification
- Example: "John" matches "John Smith (john@company.com)" and "John Doe (john.doe@startup.com)" → Ask "Which John? John Smith or John Doe?"
- Always use exact email addresses in attendees array

Examples of good responses:
- "Create 'Meeting with John' tomorrow 3pm?"
- "What time?"
- "Done"
- "You have 3 meetings tomorrow"

NEVER use phrases like "I'll help you" or "Let me". Just state the action or ask the question.`;

    if (contextInfo) {
      systemContent += `\n\nContext:\n${contextInfo}`;
    }

    const systemMessage = {
      role: 'system',
      content: systemContent
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

