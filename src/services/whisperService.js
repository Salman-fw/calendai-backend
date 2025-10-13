import OpenAI from 'openai';

let openai = null;

function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
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

