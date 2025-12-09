require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const FormData = require('form-data');

// ----------------------------------------------------
// APP
// ----------------------------------------------------
const app = express();
app.use(express.json());

// ----------------------------------------------------
// CONFIGURAÇÕES DE AMBIENTE
// ----------------------------------------------------

// OpenAI (ajuste de texto + Whisper)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Modelo para formatar texto (chat)
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';

// (Mantido caso você queira fallback em TTS, mas não é usado diretamente agora)
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'tts-1';
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';

// ElevenLabs TTS
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'c9bd234946e0599d1e08f62d589581dcb2e1c75bc5eeb058452bb975aa540820';
const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID_ROBERTA || process.env.ELEVENLABS_VOICE_ID || 'RGymW84CSmfVugnA5tvA' || 'roberta';
// Obs.: ideal é SEMPRE usar o voice_id real da Roberta, não apenas o nome.
const ELEVENLABS_MODEL_ID =
  process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5'; // pode trocar para eleven_flash_v2_5 se preferir

// Cloudflare R2
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL; // ex.: https://pub-xxxx.r2.dev

// Cliente S3 compatível com R2
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

// ----------------------------------------------------
// AJUSTE DE TEXTO PARA FALA (CHAT OPENAI)
// ----------------------------------------------------

async function ajustarTextoParaFala(textoOriginal) {
  if (!OPENAI_API_KEY) {
    // Se não tiver OpenAI configurado, segue com o texto original
    return textoOriginal;
  }

  try {
    const prompt = `
You are a VIRTUAL CUSTOMER SERVICE VOICE AGENT.

Goal:
Rewrite the text below so it sounds natural when spoken by a text-to-speech (TTS) voice, keeping the original meaning, but making it warm, clear and professional for Brazilian Portuguese (pt-BR).

Language and style rules:
- You MUST ALWAYS write in Brazilian Portuguese (pt-BR), using Brazilian vocabulary, spelling and expressions.
- NEVER use European Portuguese words or spelling.
  Examples:
  - Use "trem", not "comboio".
  - Use "ônibus", not "autocarro".
  - Use "caminhão", not "camioneta".
  - Use "você/vocês" as the neutral form; avoid "tu/vós" unless it is already in the original text.
- Keep a friendly, respectful and professional tone, like an experienced customer service agent.
- Do NOT say that you are human or that you can take physical actions.

For TTS:
- Improve punctuation (.,?!).
- Break very long sentences into shorter ones so they sound natural when spoken.
- Use commas and periods to create natural pauses in speech.
- You do NOT need to limit the length of the answer; just keep it clear and natural.

Content constraints:
- Keep the original meaning and overall tone of the message.
- Do NOT add new information, offers or questions that are not in the original text.
- Do NOT change the grammatical person (eu / você / nós) except for very small adjustments needed for fluency.
- Do NOT use quotation marks, tags, SSML, markdown or comments.
- Return ONLY the final text, ready to be spoken out loud in Brazilian Portuguese.

Original text:
"""${textoOriginal}"""
`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: OPENAI_TEXT_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a virtual customer service voice agent. ' +
              'You must ALWAYS respond in Brazilian Portuguese (pt-BR), using Brazilian vocabulary and expressions. ' +
              'Your only job is to rewrite the provided text so it sounds natural when spoken by TTS, without adding any new information.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const textoFormatado = response.data.choices[0].message.content.trim();
    return textoFormatado || textoOriginal;
  } catch (err) {
    console.error('Erro ao ajustar texto para fala:', err?.response?.data || err.message || err);
    return textoOriginal;
  }
}

// ----------------------------------------------------
// TTS ELEVENLABS (texto -> áudio MP3)
// ----------------------------------------------------

async function gerarAudioElevenLabs(texto) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY não configurada');
  }

  if (!ELEVENLABS_VOICE_ID || ELEVENLABS_VOICE_ID === 'roberta') {
    console.warn(
      'ATENÇÃO: ELEVENLABS_VOICE_ID_ROBERTA não configurada. ' +
        'Configure o voice_id real da Roberta no .env para maior estabilidade.'
    );
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

  try {
    const response = await axios.post(
      url,
      const response = await axios.post(
  `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
  {
    text: texto,
    model_id: ELEVENLABS_MODEL_ID,       // ex: "eleven_multilingual_v2"
    language_code: 'pt-BR',
    // Deixa a voz mais estável, natural e um pouco mais calma
    voice_settings: {
      stability: 0.7,            // ↑ mais estabilidade, menos variação estranha
      similarity_boost: 0.9,     // mantém bem o timbre da Roberta
      style: 0.3,                // leve variação de expressividade
      speed: 0.95,               // um pouco mais devagar, mais natural em atendimento
      use_speaker_boost: true    // deixa a voz mais clara em celular
    },
    apply_text_normalization: 'auto',
    apply_language_text_normalization: true
  },
  {
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    // formato focado em qualidade, sem otimização agressiva de latência
    params: {
      output_format: 'mp3_44100_128',
      optimize_streaming_latency: 0
    },
    responseType: 'arraybuffer',
    timeout: 30000 // 30s
  }
    );

    return Buffer.from(response.data);
  } catch (err) {
    const status = err?.response?.status;
    let body = err?.response?.data;

    console.error('Erro na chamada TTS da ElevenLabs. Status:', status);

    if (body) {
      if (Buffer.isBuffer(body)) {
        const text = body.toString('utf8');
        console.error('Corpo de erro (texto):', text);
        try {
          const json = JSON.parse(text);
          console.error('Erro JSON parseado ElevenLabs:', json);
        } catch (e) {
          // Ignora erro de parse
        }
      } else {
        console.error('Corpo de erro ElevenLabs:', body);
      }
    } else {
      console.error('Erro TTS ElevenLabs sem body:', err.message || err);
    }

    throw new Error('Falha ao chamar TTS da ElevenLabs');
  }
}

// ----------------------------------------------------
// (OPCIONAL) TTS OPENAI COMO FALLBACK
// ----------------------------------------------------

async function gerarAudioOpenAI(texto) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada');
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      {
        model: OPENAI_TTS_MODEL,
        voice: OPENAI_TTS_VOICE,
        input: texto,
        format: 'opus'
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer'
      }
    );

    return Buffer.from(response.data);
  } catch (err) {
    const status = err?.response?.status;
    let body = err?.response?.data;

    console.error('Erro na chamada TTS da OpenAI (fallback). Status:', status);

    if (body) {
      if (Buffer.isBuffer(body)) {
        const text = body.toString('utf8');
        console.error('Corpo de erro (texto):', text);
        try {
          const json = JSON.parse(text);
          console.error('Erro JSON parseado:', json);
        } catch (e) {
          // Ignora erro de parse
        }
      } else {
        console.error('Corpo de erro:', body);
      }
    } else {
      console.error('Erro TTS OpenAI sem body:', err.message || err);
    }

    throw new Error('Falha ao chamar TTS da OpenAI (fallback)');
  }
}

// ----------------------------------------------------
// SALVAR ÁUDIO NO CLOUDFLARE R2
// ----------------------------------------------------

async function salvarNoR2(buffer, userId = 'anonimo', options = {}) {
  if (!R2_BUCKET || !R2_PUBLIC_BASE_URL) {
    throw new Error('Config R2 faltando (R2_BUCKET ou R2_PUBLIC_BASE_URL)');
  }

  const { extension = 'ogg', contentType = 'audio/ogg' } = options;

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');

  const safeUserId = String(userId).replace(/[^a-zA-Z0-9_.@-]/g, '_');
  const key = `audios/${yyyy}/${mm}/${dd}/${safeUserId}_${now.getTime()}.${extension}`;

  const putCommand = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType
  });

  await r2Client.send(putCommand);

  const publicUrl = `${R2_PUBLIC_BASE_URL}/${key}`;

  return {
    uri: publicUrl,
    size: buffer.length,
    contentType
  };
}

// ----------------------------------------------------
// STT (áudio -> texto) COM WHISPER (OPENAI)
// ----------------------------------------------------

async function transcreverAudioWhisperFromUrl(audioUrl) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada');
  }

  // 1) Baixa o áudio a partir da URL
  const audioResponse = await axios.get(audioUrl, {
    responseType: 'arraybuffer'
  });

  const audioBuffer = Buffer.from(audioResponse.data);

  // 2) Envia para Whisper
  const formData = new FormData();
  formData.append('file', audioBuffer, 'audio.ogg'); // nome genérico
  formData.append('model', 'whisper-1');
  formData.append('language', 'pt'); // força português

  const response = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    formData,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        ...formData.getHeaders()
      }
    }
  );

  return response.data.text;
}

// ----------------------------------------------------
// ENDPOINTS
// ----------------------------------------------------

// POST /tts  -> texto -> áudio (URL no R2)
app.post('/tts', async (req, res) => {
  const { texto, userId } = req.body;

  if (!texto) {
    return res.status(400).json({ error: 'Campo "texto" é obrigatório' });
  }

  try {
    // 1) Ajusta o texto para fala (pontuação, pausas, etc.)
    const textoAjustado = await ajustarTextoParaFala(texto);

    console.log('Texto original:', texto);
    console.log('Texto ajustado:', textoAjustado);

    // 2) Gera o áudio com ElevenLabs (voz Roberta)
    let audioBuffer;
    try {
      audioBuffer = await gerarAudioElevenLabs(textoAjustado);
    } catch (errEleven) {
      console.error('Falha ElevenLabs TTS:', errEleven?.message || errEleven);

      // Fallback opcional para OpenAI se configurado
      if (OPENAI_API_KEY) {
        console.warn('Tentando fallback TTS com OpenAI...');
        audioBuffer = await gerarAudioOpenAI(textoAjustado);
      } else {
        throw errEleven;
      }
    }

    // 3) Salva o áudio no Cloudflare R2 como MP3
    const { uri, size } = await salvarNoR2(audioBuffer, userId, {
      extension: 'mp3',
      contentType: 'audio/mpeg'
    });

    // 4) Retorna para o chamador (ex.: Blip)
    return res.json({
      uri,
      type: 'audio/mpeg',
      size
    });
  } catch (err) {
    const status = err?.response?.status;
    let errorMessage = 'Erro ao gerar ou salvar áudio';

    // Se for erro vindo da ElevenLabs/OpenAI com JSON
    if (err?.response?.data) {
      const data = err.response.data;

      if (Buffer.isBuffer(data)) {
        const text = data.toString('utf8');
        try {
          const json = JSON.parse(text);
          if (json?.error?.message) {
            errorMessage = `TTS: ${json.error.message}`;
          }
        } catch (e) {
          // Ignora parse
        }
      } else if (typeof data === 'object' && data?.error?.message) {
        errorMessage = `TTS: ${data.error.message}`;
      }
    } else if (err.message) {
      errorMessage = err.message;
    }

    console.error('Erro no /tts:', err?.response?.data || err.message || err);
    return res.status(status || 500).json({ error: errorMessage });
  }
});

// POST /stt  -> áudio (URL) -> texto
// body: { "audioUrl": "https://..." }
app.post('/stt', async (req, res) => {
  const { audioUrl } = req.body;

  if (!audioUrl) {
    return res.status(400).json({ error: 'Campo "audioUrl" é obrigatório' });
  }

  try {
    const texto = await transcreverAudioWhisperFromUrl(audioUrl);
    return res.json({ texto });
  } catch (err) {
    console.error('Erro no /stt:', err?.response?.data || err.message || err);
    return res.status(500).json({ error: 'Erro ao transcrever áudio' });
  }
});

// ----------------------------------------------------
// INÍCIO DO SERVIDOR
// ----------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API de voz rodando na porta ${PORT}`);
});
