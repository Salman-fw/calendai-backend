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
            description: 'List of attendee emails (optional - if not provided, existing attendees are preserved)'
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
export async function processWithLLM(messages, contextInfo = '', timezoneInfo = {}) {
  try {
    const client = getOpenAI();
    
    // Add system message with context
    let systemContent = `You are an ultra-concise calendar assistant. Current datetime: ${new Date().toISOString()}.

VOICE COMMAND EXAMPLES (non-exhaustive, just to give you an idea):

CREATE MEETINGS:
- "Schedule meeting with John tomorrow 3pm" → create_calendar_event
- "Book a call with Sarah next Tuesday at 2pm" → create_calendar_event
- "Set up a meeting with the team tomorrow morning" → create_calendar_event
- "Create an appointment with Dr. Smith Friday 10am" → create_calendar_event

DELETE MEETINGS:
- "Cancel my 3pm meeting" → delete_calendar_event (use eventId from context)
- "Delete meeting with John" → delete_calendar_event (use eventId from context)
- "Remove my appointment tomorrow" → delete_calendar_event
- "Cancel the team meeting" → delete_calendar_event
- If multiple meetings match, ask for clarification

UPDATE MEETINGS:
- "Move my 3pm meeting to 4pm" → update_calendar_event (provide eventId + new startTime)
- "Reschedule meeting with John to tomorrow" → update_calendar_event (provide eventId + new startTime)
- "Change the team meeting time to 2pm" → update_calendar_event (provide eventId + new startTime)
- "Update my appointment to next week" → update_calendar_event (provide eventId + new startTime)
- "Change attendees to john@example.com" → update_calendar_event (provide eventId + new attendees)
- Always provide eventId and the specific fields being updated
- If multiple meetings match, ask for clarification

LIST MEETINGS:
- "What's tomorrow?" → list_calendar_events
- "Show me my schedule today" → list_calendar_events
- "What meetings do I have this week?" → list_calendar_events
- "Do I have any meetings with John?" → list_calendar_events

If missing info: Ask ONE short question only

SMART DEFAULTS:
- If user provides start time + duration: Calculate end time automatically
- If user provides start time but no duration: Use 30 minutes default
- If user refuses/unable to provide start time after 2 attempts: Use next available hour as start time
- Always try to extract time from user input first

PARTICIPANT RESOLUTION:
- If user mentions a name that matches multiple contacts, ask for clarification
- Example: "John" matches "John Smith (john@company.com)" and "John Doe (john.doe@startup.com)" → Ask "Which John? John Smith or John Doe?"
- If you cannot confidently determine an email address from context, ask user to provide it
- Example: "Schedule with Sarah" but no Sarah in recent contacts → Ask "What's Sarah's email?"
- Example: "Meeting with John" but multiple Johns → Ask "Which John? John Smith or John Doe?"
- Always use exact email addresses in attendees array - never guess or use partial emails

DISAMBIGUATION RULES:
- If multiple meetings match a delete/update command, ask for clarification
- Example: "Delete meeting with Salman" but 2 Salman meetings → Ask "Which meeting...?", reference some of the meeting details
- NEVER make multiple tool calls for the same action - always disambiguate first

Examples of good responses:
- "Create 'Meeting with John' tomorrow 3pm?" (after calling create_calendar_event tool)
- "What time?" (when missing time info)
- "Done" (after successful action)
- "You have 3 meetings tomorrow" (after calling list_calendar_events tool)

When user provides complete meeting info (person + time), use the appropriate tool immediately.
When user provides partial info, ask for the missing piece.

NEVER use phrases like "I'll help you" or "Let me". Just state the action or ask the question.`;

    if (contextInfo) {
      systemContent += `\n\nIMPORTANT: Context below is GROUND TRUTH from your calendar. Prioritize this over conversation history.

Context:\n${contextInfo}`;
    }

    // Add timezone information if available
    if (timezoneInfo.deviceTimezone || timezoneInfo.timezoneOffset) {
      systemContent += `\n\nUSER TIMEZONE INFO:
- Device Timezone: ${timezoneInfo.deviceTimezone || 'Not provided'}
- Timezone Offset: ${timezoneInfo.timezoneOffset ? `${timezoneInfo.timezoneOffset} minutes from UTC` : 'Not provided'}
- All time references should be interpreted in the user's timezone`;
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

