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

// OpenAI (ajuste de texto + TTS + Whisper)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Modelo para formatar texto (chat)
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';

// Modelo de TTS (texto -> fala)
// Exemplos suportados: tts-1, tts-1-hd, gpt-4o-mini-tts (depende do que sua conta permite)
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'tts-1';

// Voz do TTS
// Exemplos: alloy, echo, fable, onyx, nova, shimmer (depende do modelo/deployment)
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';

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
// TTS OPENAI (texto -> áudio MP3)
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

    // Resposta vem como binário do áudio
    return Buffer.from(response.data);
  } catch (err) {
    // Log detalhado para entender erros da OpenAI
    const status = err?.response?.status;
    let body = err?.response?.data;

    console.error('Erro na chamada TTS da OpenAI. Status:', status);

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
      console.error('Erro TTS sem body:', err.message || err);
    }

    throw new Error('Falha ao chamar TTS da OpenAI');
  }
}

// ----------------------------------------------------
// SALVAR ÁUDIO NO CLOUDFLARE R2
// ----------------------------------------------------

async function salvarNoR2(buffer, userId = 'anonimo') {
  if (!R2_BUCKET || !R2_PUBLIC_BASE_URL) {
    throw new Error('Config R2 faltando (R2_BUCKET ou R2_PUBLIC_BASE_URL)');
  }

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');

  const safeUserId = String(userId).replace(/[^a-zA-Z0-9_.@-]/g, '_');
  const key = `audios/${yyyy}/${mm}/${dd}/${safeUserId}_${now.getTime()}.mp3`;

  const putCommand = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'audio/ogg'
  });

  await r2Client.send(putCommand);

  const publicUrl = `${R2_PUBLIC_BASE_URL}/${key}`;

  return {
    uri: publicUrl,
    size: buffer.length
  };
}

// ----------------------------------------------------
// STT (áudio -> texto) COM WHISPER (OPENAI)
// ----------------------------------------------------

async function transcreverAudioWhisperFromUrl(audioUrl) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada');
  }

  // 1) Baixa o áudio a partir da URL (pode ser R2, Blip, etc.)
  const audioResponse = await axios.get(audioUrl, {
    responseType: 'arraybuffer'
  });

  const audioBuffer = Buffer.from(audioResponse.data);

  // 2) Envia para Whisper
  const formData = new FormData();
  formData.append('file', audioBuffer, 'audio.ogg'); // nome genérico
  formData.append('model', 'whisper-1'); // ou outro modelo de transcrição suportado
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

    // 2) Gera o áudio com OpenAI TTS usando o texto ajustado
    const audioBuffer = await gerarAudioOpenAI(textoAjustado);

    // 3) Salva o áudio no Cloudflare R2
    const { uri, size } = await salvarNoR2(audioBuffer, userId);

    // 4) Retorna para o chamador (ex.: Blip)
    return res.json({
      uri,
      type: 'audio/mpeg',
      size
    });
  } catch (err) {
    const status = err?.response?.status;
    let errorMessage = 'Erro ao gerar ou salvar áudio';

    // Se for erro vindo da OpenAI com JSON
    if (err?.response?.data) {
      const data = err.response.data;

      if (Buffer.isBuffer(data)) {
        const text = data.toString('utf8');
        try {
          const json = JSON.parse(text);
          if (json?.error?.message) {
            errorMessage = `OpenAI TTS: ${json.error.message}`;
          }
        } catch (e) {
          // Ignora parse
        }
      } else if (typeof data === 'object' && data?.error?.message) {
        errorMessage = `OpenAI TTS: ${data.error.message}`;
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







