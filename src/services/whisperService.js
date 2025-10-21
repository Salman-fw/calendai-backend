import OpenAI from "openai";
import { fileTypeFromBuffer } from "file-type";



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
      console.log('✅ OpenAI GPT-4o Transcribe service initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize OpenAI service:', error.message);
      throw error;
    }
  }
  return openai;
}


export async function transcribeAudio(audioBuffer, originalFilename = "audio.m4a") {
  const client = getOpenAI();

  try {
    const detected = await fileTypeFromBuffer(audioBuffer);
    const ext = detected?.ext || "m4a";
    const mime = detected?.mime || "audio/mp4";

    console.log(`🎧 Detected format: ${ext} (${mime})`);

    // ✅ Create in-memory File-like object
    const file = new File([audioBuffer], `audio.${ext}`, { type: mime });

    // ✅ Call OpenAI transcription API
    const transcription = await client.audio.transcriptions.create({
      file,
      model: "gpt-4o-mini-transcribe",
      service_tier:"priority",
      language: "en",
    });

    console.log("✅ Transcribed:", transcription.text);
    return { success: true, text: transcription.text };
  } catch (error) {
    console.error("❌ Transcribe error:", error.message);
    return { success: false, error: error.message };
  }
}