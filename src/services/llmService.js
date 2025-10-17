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
    
    // Calculate user's local time based on timezone offset
    let currentTime = new Date().toISOString();
    if (timezoneInfo.timezoneOffset) {
      const offsetMinutes = parseInt(timezoneInfo.timezoneOffset);
      const userLocalTime = new Date(Date.now() + offsetMinutes * 60000);
      // Format as YYYY-MM-DD HH:MM:SS in user's timezone
      const year = userLocalTime.getUTCFullYear();
      const month = String(userLocalTime.getUTCMonth() + 1).padStart(2, '0');
      const day = String(userLocalTime.getUTCDate()).padStart(2, '0');
      const hours = String(userLocalTime.getUTCHours()).padStart(2, '0');
      const minutes = String(userLocalTime.getUTCMinutes()).padStart(2, '0');
      const seconds = String(userLocalTime.getUTCSeconds()).padStart(2, '0');
      currentTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds} (${timezoneInfo.deviceTimezone || 'UTC+' + (offsetMinutes/60)})`;
    }
    
    // Add system message with context
      let systemContent = `You are a precise voice-controlled calendar assistant. Current datetime in user's timezone: ${currentTime}.

🚨 CRITICAL: NEVER include Google Calendar URLs, event IDs, or "[View in Calendar]" links in your responses. Only include meeting title and time in plain text format.

RESPONSE LENGTH RULE:
- Keep responses to 1-liners whenever possible
- Only provide detailed responses when user explicitly asks for meeting details, schedules, or specific information
- Examples of 1-liners: "Done", "What time?", "Who should attend?", "Meeting with John tomorrow 3pm?"
- Examples of detailed responses: Only when user asks "What meetings do I have today?" or "Show me my schedule"

🚨 CRITICAL CONVERSATION MEMORY RULE:
- When user asks about details of previously mentioned meetings, you MUST look at the tool responses in conversation history
- Tool responses contain the EXACT attendee emails, times, and event details
- NEVER guess or make up email addresses - always extract from tool response data
- If you see a tool response with attendee data, use that exact email address
- Example: If tool response shows "email": "salman@futurewatch.com", then say "salman@futurewatch.com" not "sam@example.com"
- In case of multiple meetings or any other ambiguity, ask the user to clarify or make a new tool call to search for the meeting, and reference those to request user for clarification.

CRITICAL: Input comes from voice transcription and may contain errors. Be skeptical of:
- Unusual names or spellings (e.g., "Salman" vs "Salmon", "Mira" vs "Mirror")
- Email addresses (voice transcription often mangles these)

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

CRITICAL DATE PRECISION:
- When user asks for "today", query ONLY the current date (same date as shown in "Current datetime")
- Example: If current datetime shows "2025-10-17", then "today" = 2025-10-17T00:00:00+05:00 to 2025-10-17T23:59:59+05:00
- NEVER query multiple days for "today" - use exact date boundaries
- For "tomorrow" or similar, query the day after the current date
- For "yesterday" or similar, query the day before the current date
- For "this week" or similar, query from current date to 7 days later
- For "last month" or similar, query from 28/29/30/31 days ago to current date (whichever is correct)

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

CONVERSATION MEMORY & CONTEXT USAGE:
- ALWAYS check conversation history for previous tool responses when answering questions about past events
- When user asks about attendees, times, or details of previously MENTIONED meetings i.e. they were mentioned in the conversation history, extract this information from the conversation history
- Tool responses contain complete event details - use this data instead of guessing or hallucinating
- Example: If user asks "Who was in my meeting with Sam?" and you previously called list_calendar_events, look at the tool response for attendee details
- NEVER make up email addresses or meeting details - always use data from previous tool calls
- If you don't have the information in conversation history, ask the user to clarify or make a new tool call

ACCURATE DATA EXTRACTION:
- When referencing past events, extract exact details from tool responses in conversation history
- Attendee emails, meeting times, and event IDs should come from actual tool responses, not assumptions
- If multiple events match a question, reference the specific event details from the tool response
- Example: "The attendee was salman@futurewatch.com" (from tool response) not "john@example.com" (hallucinated)

Examples of good responses:
- "Create 'Meeting with John' tomorrow 3pm?" (after calling create_calendar_event tool)
- "What time?" (when missing time info)
- "Done" (after successful action)
- "You have 3 meetings tomorrow" (after calling list_calendar_events tool)
- "Who should attend?" (when missing attendees)
- "Meeting cancelled" (after delete action)
- Keep responses concise - avoid unnecessary words or explanations

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
- All time references should be interpreted in the user's timezone

CRITICAL TIMEZONE HANDLING FOR TOOL CALLS:
- When making tool calls (create_calendar_event, update_calendar_event, list_calendar_events), ALL datetime parameters MUST be in ISO 8601 format with the user's timezone offset
- Example: If user says "3pm tomorrow" and their timezone offset is +300 minutes (UTC+5), the startTime should be: "2025-10-17T15:00:00+05:00"
- For list_calendar_events: timeMin and timeMax must include the user's timezone offset
- For create_calendar_event: startTime and endTime must include the user's timezone offset  
- For update_calendar_event: startTime and endTime must include the user's timezone offset, unless being reused from the existing event, e.g. user asked to rename the meeting, in that case keep the existing times.
- NEVER send UTC times without timezone offset - always include the user's timezone in the ISO string

CRITICAL RESPONSE FORMATTING RULES:
- ABSOLUTELY FORBIDDEN: Never include Google Calendar URLs, event IDs, or any technical links in your response
- ABSOLUTELY FORBIDDEN: Never include "[View in Calendar]" links or similar
- ABSOLUTELY FORBIDDEN: Never include any URLs or technical identifiers
- ONLY include: meeting title, time, and duration (if relevant)
- For list_calendar_events: Use simple format like "You have 2 meetings today: Meeting with Sam at 8:00 AM and Physio at 9:30 PM"
- NEVER use markdown formatting like **bold** or bullet points in voice responses
- Keep responses plain text, suitable for text-to-speech
- Example CORRECT: "You have 2 meetings today: Meeting with Sam at 8:00 AM and Physio at 9:30 PM"
- Example WRONG: "You have 2 meetings today:\n- \"Meeting with Sam\" at 8:00 AM\n- \"Physio\" at 9:30 PM"
`;
    }

    const systemMessage = {
      role: 'system',
      content: systemContent
    };

    const allMessages = [systemMessage, ...messages];
    
    console.log('🔵 LLM INPUT - Full messages array:');
    console.log(JSON.stringify(allMessages, null, 2));

    const response = await client.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: allMessages,
      tools,
      tool_choice: 'auto'
    });

    const responseMessage = response.choices[0].message;

    console.log('🟢 LLM OUTPUT - Response message:');
    console.log(JSON.stringify(responseMessage, null, 2));

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

