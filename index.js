require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const FormData = require('form-data');

const app = express();
app.use(express.json());

// ----------------- CONFIGURAÇÕES -----------------

// ElevenLabs (TTS)
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID; // voz PT-BR

// OpenAI (Whisper + ajuste de texto)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

// ----------------- AJUSTE DE TEXTO PARA FALA -----------------

async function ajustarTextoParaFala(textoOriginal) {
  if (!OPENAI_API_KEY) {
    // Se não tiver OpenAI configurado, segue com o texto original
    return textoOriginal;
  }

  try {
    const prompt = `
Você é um assistente que ajusta textos para serem lidos em voz alta em português do Brasil.

Tarefas:
- Corrija pontuação (.,?!).
- Separe frases muito longas.
- Mantenha o sentido original.
- Não acrescente informações novas.
- Não mude de pessoa (eu / você / nós).
- Não coloque aspas, tags ou comentários, retorne APENAS o texto final.

Texto:
"""${textoOriginal}"""
`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini', // pode trocar por outro modelo se quiser
        messages: [
          {
            role: 'system',
            content: 'Você formata texto em PT-BR para ser lido em voz alta por uma voz de IA.'
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

// ----------------- TTS (texto -> áudio) -----------------

async function gerarAudioElevenLabs(texto) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    throw new Error('Config ElevenLabs faltando (API KEY ou VOICE_ID)');
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

  const response = await axios.post(
    url,
    {
      text: texto,
      model_id: 'eleven_multilingual_v2', // suporta bem PT-BR
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8
      }
    },
    {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      responseType: 'arraybuffer'
    }
  );

  return Buffer.from(response.data);
}

async function salvarNoR2(buffer, userId = 'anonimo') {
  if (!R2_BUCKET || !R2_PUBLIC_BASE_URL) {
    throw new Error('Config R2 faltando (R2_BUCKET ou R2_PUBLIC_BASE_URL)');
  }

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');

  const safeUserId = String(userId).replace(/[^a-zA-Z0-9_\-@.]/g, '_');
  const key = `audios/${yyyy}/${mm}/${dd}/${safeUserId}_${now.getTime()}.mp3`;

  const putCommand = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'audio/mpeg'
  });

  await r2Client.send(putCommand);

  const publicUrl = `${R2_PUBLIC_BASE_URL}/${key}`;

  return {
    uri: publicUrl,
    size: buffer.length
  };
}

// ----------------- STT (áudio -> texto) -----------------

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

// ----------------- ENDPOINTS -----------------

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

    // 2) Gera o áudio com ElevenLabs usando o texto ajustado
    const audioBuffer = await gerarAudioElevenLabs(textoAjustado);

    // 3) Salva o áudio no Cloudflare R2
    const { uri, size } = await salvarNoR2(audioBuffer, userId);

    // 4) Retorna para o chamador (ex.: Blip)
    return res.json({
      uri,
      type: 'audio/mpeg',
      size
    });
  } } catch (err) {
  const status = err?.response?.status;
  const headers = err?.response?.headers;
  let body = err?.response?.data;

  // Se for Buffer (caso típico por causa do responseType: 'arraybuffer')
  if (body && Buffer.isBuffer(body)) {
    try {
      const text = body.toString('utf8');
      console.error('Erro no /tts STATUS:', status);
      console.error('Headers:', headers);
      console.error('Body:', text);

      try {
        const json = JSON.parse(text);
        console.error('JSON parsed:', json);
      } catch (e) {
        // não era JSON, então ignora
      }
    } catch (e) {
      console.error('Erro convertendo Buffer pra string:', e);
    }
  } else {
    console.error('Erro no /tts:', err?.response?.data || err.message || err);
  }

  return res.status(500).json({ error: 'Erro ao gerar ou salvar áudio' });
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

// ----------------- INÍCIO DO SERVIDOR -----------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API de voz rodando na porta ${PORT}`);
});

