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
      name: 'list_tasks',
      description: 'Get tasks from the user\'s task list for a specified time range',
      parameters: {
        type: 'object',
        properties: {
          timeMin: {
            type: 'string',
            description: 'Minimum due date in ISO 8601 format (e.g., 2025-10-15T00:00:00Z). Tasks without due dates are also included'
          },
          timeMax: {
            type: 'string',
            description: 'Maximum due date in ISO 8601 format'
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of tasks to return (default: 100)'
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
          },
          calendar: {
            type: 'string',
            enum: ['google', 'outlook'],
            description: 'Calendar to create event in: "google" for Google Calendar, "outlook" for Outlook Calendar. REQUIRED - use primary calendar if user doesn\'t specify.'
          }
        },
        required: ['summary', 'startTime', 'attendees', 'calendar']
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
          },
          calendar: {
            type: 'string',
            enum: ['google', 'outlook'],
            description: 'Calendar containing the event: "google" for Google Calendar, "outlook" for Outlook Calendar. REQUIRED - use primary calendar if user doesn\'t specify.'
          }
        },
        required: ['eventId', 'calendar']
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
          },
          calendar: {
            type: 'string',
            enum: ['google', 'outlook'],
            description: 'Calendar containing the event: "google" for Google Calendar, "outlook" for Outlook Calendar. REQUIRED - use primary calendar if user doesn\'t specify.'
          }
        },
        required: ['eventId', 'calendar']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a new task in the user\'s task list',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Task title/name (required)'
          },
          notes: {
            type: 'string',
            description: 'Task notes/description (optional)'
          },
          due: {
            type: 'string',
            description: 'Due date in ISO 8601 format (YYYY-MM-DD or RFC3339). If not provided, task has no due date'
          },
          calendar: {
            type: 'string',
            enum: ['google', 'outlook'],
            description: 'Calendar to create task in: "google" for Google Tasks, "outlook" for Outlook Tasks. REQUIRED - use primary calendar if user doesn\'t specify.'
          }
        },
        required: ['title', 'calendar']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Update an existing task',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'ID of the task to update'
          },
          title: {
            type: 'string',
            description: 'Updated task title'
          },
          notes: {
            type: 'string',
            description: 'Updated task notes/description'
          },
          due: {
            type: 'string',
            description: 'Updated due date in ISO 8601 format (YYYY-MM-DD or RFC3339). Set to empty string to remove due date'
          },
          calendar: {
            type: 'string',
            enum: ['google', 'outlook'],
            description: 'Calendar containing the task: "google" for Google Tasks, "outlook" for Outlook Tasks. REQUIRED - use primary calendar if user doesn\'t specify.'
          }
        },
        required: ['taskId', 'calendar']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_task',
      description: 'Delete a task',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'ID of the task to delete'
          },
          calendar: {
            type: 'string',
            enum: ['google', 'outlook'],
            description: 'Calendar containing the task: "google" for Google Tasks, "outlook" for Outlook Tasks. REQUIRED - use primary calendar if user doesn\'t specify.'
          }
        },
        required: ['taskId', 'calendar']
      }
    }
  }
];

// Consolidated timezone handling & instructions
const getConsolidatedTimezoneInstructions = (currentTime, timezoneInfo) => {
  let tzSection = `
IMPORTANT: All datetime and time references must be interpreted and presented in the user's timezone.
- User's current datetime: ${currentTime}
`;

  if (timezoneInfo.deviceTimezone || timezoneInfo.timezoneOffset) {
    tzSection += `
USER TIMEZONE DETAILS:
- Your/server time is UTC, so for example a user is in UTC+5, then 3pm UTC is 8pm in their timezone. So if you are about to say 3pm in your response, after factoring in the timezone offset, you must say 8 pm. You MUST adjust the time according to the user's timezone.
- Device Timezone: ${timezoneInfo.deviceTimezone || 'Not provided'}
- Timezone Offset: ${timezoneInfo.timezoneOffset ? `${timezoneInfo.timezoneOffset} minutes from UTC` : 'Not provided'}

TIMEZONE RULES FOR TOOL CALLS & RESPONSES:
- All datetime parameters for tool calls (list_calendar_events, create_calendar_event, update_calendar_event) MUST be in ISO 8601 format with the user's timezone offset.
  - Example: If user says "3pm tomorrow" and their timezone offset is +300 minutes (UTC+5), use "YYYY-MM-DDT15:00:00+05:00".
  - For list_calendar_events: timeMin and timeMax must include the user's timezone offset.
  - For create_calendar_event: startTime and endTime must include the user's timezone offset. If not provided, default endTime to 30 mins after startTime.
  - For update_calendar_event: updated times must include the user's timezone offset, unless reusing the existing event time (i.e., only updating the event name or participants).
- NEVER use UTC times without a timezone offset.
- NEVER include GMT, UTC, or timezone abbreviations in user-facing responses; always present local time as human readable (Text-To-Speech friendly), with NO technical notation.
- In your responses, always present dates/times as human-friendly in the user's timezone. Never output event IDs, URLs, or technical metadata.
`;
  }

  tzSection += `
IMPORTANT TIME-PHRASE INTERPRETATION:
- When user says "today", always refer to the rest of the day from current time in their timezone.
- For "tomorrow", "yesterday", "this week", etc., always calculate ranges using the user's timezone and show/present data in their local time after receiving tool call results (not UTC).
- If in doubt about the intended time or range, ask the user for clarification in a concise way.

CRITICAL RESPONSE RULES:
- For times in responses, do NOT include timezone abbreviations or offsets, just give the plain time in local user's terms (e.g., "3 PM" not "3 PM UTC+5").
- NEVER include Google Calendar URLs, event IDs, or any technical/metadata in responses.
- ALL user-facing responses MUST be human readable and Text-To-Speech friendly and MUST be in the user's timezone.
`;

  return tzSection;
};

// Process user message with GPT function calling
export async function processWithLLM(messages, contextInfo = '', timezoneInfo = {}, inputModality = 'voice', primaryCalendar = 'google') {
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
    const inputTypeNote = inputModality === 'text' 
      ? `INPUT MODALITY: The user is interacting via TEXT INPUT. The input is typed directly and should be more precise than voice transcriptions. You can expect:
- More accurate spelling of names, emails, and technical terms
- Ability to handle more complex queries and longer messages
- Less need to account for transcription errors
- Responses can be slightly more detailed since the user can read them (though still keep them concise)`
      : `INPUT MODALITY: The user is interacting via VOICE INPUT. The input comes from voice transcription and may contain errors. Be skeptical of:
- Unusual names or spellings (e.g., "Salman" vs "Salmon", "Mira" vs "Mirror")
- Email addresses (voice transcription often mangles these)
- Responses MUST be Text-To-Speech friendly and concise`;

    let systemContent = `
    SUPER IMPORTANT: if the user asks "test alpha bravo" then you must respond with "ok"
    SUPER IMPORTANT: if the user says "test alpha cr" then you must create a meeting with salma.fw@outlook.com at 3pm today titled "testing"
    SUPER IMPORTANT: if the user says "test alpha up" then you must update the meeting with salma.fw@outlook.com which is today, titled "testing", and push it fwd by 1 hour
    SUPER IMPORTANT: if the user says "test alpha de" then you must delete the meeting with salma.fw@outlook.com which is today, titled "testing"

    RESPONSIBILITY & GENERAL INSTRUCTIONS:
      You are a precise ${inputModality === 'text' ? 'text-based' : 'voice-controlled'} calendar assistant.
      ${inputModality === 'text' 
        ? 'You will receive typed text messages and need to perform tool calls and/or generate responses based on the context/previous conversation history/tool calls.'
        : 'You will receive voice command transcriptions and need to perform tool calls and/or generate responses based on the context/previous conversation history/tool calls.'}
      Your responses should be concise yet engaging. Be informative, helpful and personable - offer relevant insights, recommendations, or follow-up questions when appropriate, but keep the core response brief. Only provide extensive detail when explicitly requested.
      ${inputModality === 'text' 
        ? 'Responses should be clear and readable (the user will read them, not hear them).'
        : 'Responses MUST be Text-To-Speech friendly, and exclusively in English.'}
      ${inputModality === 'voice' 
        ? 'If the transcription is not in English, is gibberish, or is unclear, respond: "I\'m sorry, I don\'t understand that. Could you repeat?" and ask clarifying questions only if warranted.'
        : 'If the message is unclear, ask for clarification in a concise way.'}
      You are expected to create, update, delete, and list meetings/details and tasks based on the user's voice commands, using the appropriate tool calls and/or generating responses based on the context and conversation history.
      The user may ask you to search for events in the past, future, in specific time ranges (e.g. this week, next week, last month), in that case you must use the list_calendar_events tool call. Make sure you pass the correct timeMin and timeMax parameters to the list_calendar_events tool call. When in doubt, ask the user to clarify the time range.
      The user may also ask you to search for tasks in specific time ranges, in that case you must use the list_tasks tool call with appropriate timeMin and timeMax parameters.
      Remain aware of the user's timezone and the current datetime in the user's timezone, and any potential ambiguity that might arise. Handle timezone ambiguities gracefully without mentioning technical details.
      Remain aware user may use interchangeable vocabulary for the same event, task, etc. For example, "meeting with John" could be "call with John" or "call with John tomorrow". Similarly, "task to call John" could be "reminder to call John tomorrow" or "todo item: call John tomorrow".
      Pay attention to update cases, don't just create a new event, prioritize updating the existing event if exists.



${getConsolidatedTimezoneInstructions(currentTime, timezoneInfo)}

CALENDAR SELECTION RULES:
- The user's primary calendar is: ${primaryCalendar}
- Mutating tool calls MUST include the "calendar" parameter
- Use "${primaryCalendar}" as the default calendar for all tool calls UNLESS the user explicitly specifies a different calendar
- If the user mentions stuff like (non exhaustive )"Google Calendar", "Google", or "Gmail calendar" → use "google"
- If the user mentions stuff like (non exhaustive list): "Outlook Calendar", "Outlook", or "Microsoft calendar" → use "outlook"
- Examples:
  * "Create a meeting" → use "${primaryCalendar}" (default)
  * "Create a meeting in my Outlook calendar" → use "outlook"
  * "Delete the meeting from Google" → use "google"

RESPONSE LENGTH RULES:
- Keep responses as short as possible.
- Only provide detailed responses when user asks explicitly for meeting details, schedules, or specific information.
- If providing time/date, ensure it's human-friendly in the user's timezone (never in UTC or GMT, and never with technical time-zone notation).
- Example concise responses: "Done", "What time?", "Who should attend?"
- Example detailed responses: Only when user asks "What meetings do I have today?" or "Show me my schedule"

CONVERSATION MEMORY & DATA USE:
- Perform tool calls and/or use data from tool responses and previous conversation context - never guess or hallucinate details (emails, times, titles).
- If multiple meetings or ambiguity, ask for clarification before proceeding.
- If missing information, ask ONE short clear question.

${inputTypeNote}

CREATE MEETINGS:
- "Schedule meeting with John tomorrow 3pm" → create_calendar_event
- "Book a call with Sarah next Tuesday at 2pm" → create_calendar_event
- "Set some time with the team tomorrow morning" → create_calendar_event
- "Create an appointment with Dr. Smith Friday 10am" → create_calendar_event

DELETE MEETINGS:
- "Cancel my 3pm meeting" → delete_calendar_event (use eventId from context)
- "Delete meeting with John" → delete_calendar_event (use eventId from context)
- "Remove my appointment tomorrow" → delete_calendar_event
- "Drop the team meeting" → delete_calendar_event
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

CREATE TASKS:
- "Add task to review documents" → create_task (title: "Review documents")
- "Create task to call John tomorrow" → create_task (title: "Call John", due: tomorrow's date)
- "Set a reminder to finish the report" → create_task (title: "Finish the report")
- "Add a task for next week to prepare presentation" → create_task (title: "Prepare presentation", due: next week's date)
- "Task: buy groceries" → create_task (title: "Buy groceries")
- If user mentions a due date, include it in the due parameter. If no due date, task can be created without one.

UPDATE TASKS:
- "Mark task 'Review documents' as done" → update_task (provide taskId from context)
- "Change task due date to tomorrow" → update_task (provide taskId + new due date)
- "Update task title to 'Review final documents'" → update_task (provide taskId + new title)
- "Add notes to my task" → update_task (provide taskId + notes)
- Always provide taskId from context. If multiple tasks match, ask for clarification.

DELETE TASKS:
- "Delete task 'Review documents'" → delete_task (use taskId from context)
- "Remove my task to call John" → delete_task (use taskId from context)
- "Mark task as complete and remove it" → delete_task (use taskId from context)
- If multiple tasks match, ask for clarification

LIST TASKS:
- "What tasks do I have?" → list_tasks
- "Show me my tasks for this week" → list_tasks (with appropriate timeMin/timeMax)
- "What's on my task list today?" → list_tasks (with today's date range)
- "List all my pending tasks" → list_tasks

CRITICAL DATE PRECISION:
- IMPORTANT: Present all times in human-readable format in the user's local timezone (no UTC/GMT/timezone offsets shown to user).
- When user asks for "today", query ONLY the current date (same date as shown in "Current datetime")
- For "tomorrow" or similar, query the day after the current date - factor in the timezone offset
- For "yesterday" or similar, query the day before the current date - factor in the timezone offset
- For "this week" or similar, query from current date to 7 days later - factor in the timezone offset
- For "last month" or similar, query from 28/29/30/31 days ago to current date (whichever is correct) - factor in the timezone offset

If missing info: Ask ONE short question only

SMART DEFAULTS:
- If user provides start time + duration: Calculate end time automatically
- If user provides start time but no duration: Use 30 minutes default
- If user refuses/unable to provide start time after 2 attempts: Use next available hour as start time
- Always try to extract time from user input first

PARTICIPANT RESOLUTION:
- Consider phonetic/sound-alike names: "Jon"/"John", "Sara"/"Sarah", "Salman"/"Salmon"
- If transcribed name sounds similar to a known contact, confirm: "Did you mean [contact name]?"
- If user mentions a name that matches multiple contacts, ask for clarification
- Example: "John" matches "John Smith (john@company.com)" and "John Doe (john.doe@startup.com)" → Ask "Which John? John Smith or John Doe?"
- If you cannot confidently determine an email address from context (frequent/recent usernames and emails are supplied in context), ask user to provide it
- Example: "Schedule with Sarah" but no Sarah in recent contacts → Ask "What's Sarah's email?"
- Example: "Meeting with John" but multiple Johns → Ask "Which John? John Smith or John Doe?"
- Always use exact email addresses in attendees array - never guess or use partial emails

DISAMBIGUATION RULES:
- If multiple meetings match a delete/update command, ask for clarification
- Example: "Delete meeting with Salman" but 2 Salman meetings → Ask "Which meeting...?", reference some of the meeting details
- NEVER make multiple tool calls for the same action - always disambiguate first

CONVERSATION MEMORY & CONTEXT USAGE:
- Consider conversation history and previous tool responses when answering questions about past events
- Tool responses contain complete event details - use this data instead of guessing or hallucinating
- Example: If user asks "Who was in my meeting with Sam?" and you previously called list_calendar_events, look at the tool response for attendee details
- NEVER make up email addresses or meeting details - always use data from previous tool calls
- If you don't have the information in conversation history, ask the user to clarify or make a new tool call

ACCURATE DATA EXTRACTION:
- When referencing past events, extract exact details from tool responses in conversation history; if not present, make a tool call to get the information.
- If multiple events match a question, reference the specific event details from the tool response
- Example: "The attendee was salman@futurewatch.com" (from tool response) not "john@example.com" (hallucinated)

CRITICAL CONFIRMATION RESPONSE RULES:
- When calling create_calendar_event, update_calendar_event, or delete_calendar_event tools, DO NOT include specific times/dates in your response
- Instead, use generic confirmation phrases like:
  - "Sure, I'll create this meeting. Could you confirm if these details look alright?"
  - "I'll update that meeting for you. Does this look good?"
  - "I'll cancel that meeting. Should I proceed?"
- The user will see the full meeting details (time, date, attendees) in the confirmation UI, so you don't need to repeat them

Examples of good responses:
- "Sure, I'll create this meeting. Could you confirm if these details look alright?" (after calling create_calendar_event tool)
- "What time?" (when missing time info)
- "Done" (after successful action)
- "You have 3 meetings tomorrow" (after calling list_calendar_events tool)
- "Who should attend?" (when missing attendees)
- "Meeting cancelled" (after delete action)
- Keep responses concise - avoid unnecessary words or explanations

When user provides complete meeting info (person + time), use the appropriate tool immediately.
When user provides partial info, ask for the missing piece.

CRITICAL RESPONSE FORMATTING RULES:
- ABSOLUTELY FORBIDDEN: Never include Google Calendar URLs, event IDs, or any technical links in your response
- ONLY include: meeting title and time in the user's timezone, human readable, text-to-speech friendly format. You may include duration and attendees (if relevant).
- For list_calendar_events: Use simple format like "You have 2 meetings today: Meeting with Sam at 8:00 AM and Physio at 9:30 PM"
- NEVER use markdown formatting like **bold** or bullet points in voice responses
- Example CORRECT: "You have 2 meetings today: Meeting with Sam at 8:00 AM and Physio at 9:30 PM"
- Example WRONG: "You have 2 meetings today:\n- \"Meeting with Sam\" at 8:00 AM\n- \"Physio\" at 9:30 PM"
- Example WRONG: "You have 2 meetings today: Meeting with Sam at 8:00 AM (UTC+5) and Physio at 9:30 PM (UTC+5)"

ADDITIONAL EXAMPLES & FLOWS:
User: What's my day like today? / How many meetings do I have today? / Is my day busy today? 
You: Your day today looks a bit tight, you have [number of meetings today]. Do you want me to narrate your schedule event-wise?
---
User: What is my meeting with XYZ about? 
You: Your meeting is titled [meeting title]. 
---
User: When is my meeting/next meeting with XYZ? 
You: [investigate whether there is a meeting with XYZ in that day only] You dont have any meeting with XYZ today, do you want me to set some time? [Alternatively, if there is a meeting with XYZ in that day, you can say "Your meeting with XYZ is tomorrow at [time]"]
---
User: Do I have any Meetings with XYZ
You: You are meeting with XYZ for [Meeting Title] at 2pm today. Later, you will have a meeting with XYZ again for [title] at 5pm today [Alternatively, in case no meeting found, you can say "You don't have any meetings with XYZ today. Do you want me to set a meeting?"]
---
User: what are my free slots on Thursday?
You: You're free in the following time slots: 
  - Before 12pm 
  - 2pm to 4pm 
  - 5pm onwards
  Do you want to set a meeting ?
---
User: Who all is participating in the meeting?
You: [name 1],[name 2], [name 3] will be joining your call on [meeting name] at [time] (today/ on [day])
---






`;

    if (contextInfo) {
      systemContent += `\n\nIMPORTANT: Context below is GROUND TRUTH from your calendar.

Context:\n${contextInfo}`;
    }

    const systemMessage = {
      role: 'system',
      content: systemContent
    };

    const allMessages = [systemMessage, ...messages];
    
    if (process.env.DEBUG_LLM === 'true') {
      console.log('🔵 LLM INPUT - Full messages array:');
      console.log(JSON.stringify(allMessages, null, 2));
    }

    const response = await client.chat.completions.create({
      model: process.env.LLM_MODEL,
      messages: allMessages,
      tools,
      tool_choice: 'auto',
      service_tier:"priority"

    });

    const responseMessage = response.choices[0].message;

    if (process.env.DEBUG_LLM === 'true') {
      console.log('🟢 LLM OUTPUT - Response message:');
      console.log(JSON.stringify(responseMessage, null, 2));
    }

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

