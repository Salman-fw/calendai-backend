import OpenAI from 'openai';

let openai = null;

function getOpenAI() {
  if (!openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    
    if (!apiKey || apiKey === 'your_openai_api_key_here') {
      console.error('⚠️  OPENAI_API_KEY not configured or using placeholder value');
      throw new Error('OpenAI API key not configured');
    }
    
    try {
      openai = new OpenAI({ apiKey });
      console.log('✅ OpenAI Whisper service initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize OpenAI service:', error.message);
      throw error;
    }
  }
  return openai;
}

export async function transcribeAudio(audioBuffer, filename = 'audio.webm') {
  const client = getOpenAI();
  try {
    // Create a File-like object from buffer
    const file = new File([audioBuffer], filename, { type: 'audio/webm' });
    
    const transcription = await client.audio.transcriptions.create({
      file: file,
      model: 'whisper-1',
      language: 'en',
      service_tier:"priority"
    });

    return {
      success: true,
      text: transcription.text
    };
  } catch (error) {
    console.error('Whisper API error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

