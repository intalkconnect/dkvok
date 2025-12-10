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

// OpenAI (apenas para Whisper e ajuste de texto)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ElevenLabs TTS - Configurações otimizadas para pt-BR
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'c9bd234946e0599d1e08f62d589581dcb2e1c75bc5eeb058452bb975aa540820';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID_ROBERTA || 'RGymW84CSmfVugnA5tvA'; // Voz Roberta para pt-BR
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2'; // Melhor para português

// Silêncio inicial (em milissegundos)
const SILENCE_DURATION_MS = 800;

// Cloudflare R2
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;

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
// AJUSTE DE TEXTO PARA FALA EM PT-BR (CHAT OPENAI)
// ----------------------------------------------------

async function ajustarTextoParaFalaPtBR(textoOriginal) {
  if (!OPENAI_API_KEY) {
    return textoOriginal;
  }

  try {
    const prompt = `
Você é um especialista em adaptar textos para fala natural em português brasileiro (pt-BR).
Seu objetivo é reescrever o texto abaixo para soar completamente natural quando falado por TTS.

REGRAS PARA PORTUGUÊS BRASILEIRO (PT-BR):
1. Use SEMPRE vocabulário, ortografia e expressões brasileiras.
2. NUNCA use palavras ou construções do português europeu.
   Exemplos obrigatórios:
   - Use "ônibus", NUNCA "autocarro"
   - Use "trem", NUNCA "comboio"
   - Use "caminhão", NUNCA "camioneta"
   - Use "celular", NUNCA "telemóvel"
   - Use "suco", NUNCA "sumo"
   - Use "sorvete", NUNCA "gelado"
   - Use "banheiro", NUNCA "casa de banho"
   - Use "time", NUNCA "equipa"
   - Use "fila", NUNCA "bicha"

ESTRATÉGIAS DE HUMANIZAÇÃO PARA PT-BR:
1. Adicione expressões naturais brasileiras:
   - "Olha só..." "Então..." "Bom..." "Pois é..." 
   - "Tá certo?" "Entendeu?" "Sabe como é?"
   - "Vamos lá" "Pode deixar" "Sem problema"

2. Ajuste a estrutura das frases:
   - Quebre frases longas em sentenças menores (máximo 12-15 palavras)
   - Use vírgulas para criar pausas naturais no lugar certo
   - Coloque o sujeito antes do verbo (padrão brasileiro)
   - Evite inversões muito formais

3. Torne a linguagem mais coloquial (sem ser informal demais):
   - Substitua "portanto" por "então" ou "por isso"
   - Substitua "contudo" por "mas" ou "porém"
   - Substitua "desse modo" por "assim" ou "dessa forma"
   - Use "a gente" quando apropriado (em vez de "nós" muito formal)

PONTUAÇÃO PARA TTS EM PT-BR:
- Vírgula (,): pausa curta (respiração)
- Ponto (.): pausa média (mudança de ideia)
- Ponto final (.): sempre no final de cada frase
- Ponto de interrogação (?): mantenha a entonação natural
- Ponto de exclamação (!): use com moderação
- NÃO use reticências (...) - causam instabilidade na voz

RESTRIÇÕES:
- Mantenha o significado original
- Não adicione informações novas
- Não use aspas, tags, SSML ou markdown
- Retorne APENAS o texto final em pt-BR

Texto original:
"""${textoOriginal}"""

Texto adaptado para fala natural em português brasileiro:
`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Você é um especialista brasileiro em adaptar textos para fala natural em TTS. Você SEMPRE responde em português brasileiro (pt-BR) usando vocabulário e expressões brasileiras. Seu trabalho é fazer o texto soar como se fosse falado por uma pessoa real do Brasil.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.5,
        max_tokens: 2000
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
// TTS ELEVENLABS OTIMIZADO PARA PT-BR
// ----------------------------------------------------

async function gerarAudioElevenLabsPtBR(texto) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY não configurada');
  }

  if (!ELEVENLABS_VOICE_ID) {
    throw new Error('ELEVENLABS_VOICE_ID não configurada');
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

  try {
    const response = await axios.post(
      url,
      {
        text: texto,
        model_id: ELEVENLABS_MODEL_ID,
        language_code: 'pt-br', // Especifica português brasileiro
        voice_settings: {
          stability: 0.65,             // Mais estável para evitar tremulação
          similarity_boost: 0.70,      // Balanceado para naturalidade
          style: 0.10,                 // Baixo para evitar artificialidade
          speed: 0.95,                 // Velocidade natural brasileira
          use_speaker_boost: true,     // Mantém características da voz
          emotion: 'neutral'           // Emoção neutra para clareza
        },
        pronunciation_dictionary_locators: [],
        generation_config: {
          chunk_length_schedule: [120, 160, 250, 290]
        }
      },
      {
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/wav'
        },
        params: {
          output_format: 'pcm_16000', // Formato de alta qualidade
          optimize_streaming_latency: 3
        },
        responseType: 'arraybuffer',
        timeout: 60000 // 60 segundos
      }
    );

    return Buffer.from(response.data);
  } catch (err) {
    console.error('Erro na chamada TTS da ElevenLabs:', {
      status: err?.response?.status,
      message: err?.message,
      data: err?.response?.data ? err.response.data.toString().substring(0, 200) : null
    });

    // Se for erro de voz não disponível para pt-br, tenta com configuração alternativa
    if (err?.response?.status === 422) {
      console.warn('Tentando configuração alternativa para pt-br...');
      return await gerarAudioElevenLabsAlternativo(texto);
    }

    throw new Error(`Falha ao gerar áudio: ${err?.message || 'Erro desconhecido'}`);
  }
}

// Configuração alternativa para pt-br
async function gerarAudioElevenLabsAlternativo(texto) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

  const response = await axios.post(
    url,
    {
      text: texto,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.75,
        similarity_boost: 0.80,
        style: 0.0,
        speed: 1.0,
        use_speaker_boost: true
      }
    },
    {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg'
      },
      responseType: 'arraybuffer',
      timeout: 60000
    }
  );

  return Buffer.from(response.data);
}

// ----------------------------------------------------
// ADICIONAR SILÊNCIO INICIAL AO ÁUDIO
// ----------------------------------------------------

function adicionarSilencioInicial(audioBuffer, durationMs = 800) {
  try {
    // Para PCM 16kHz, 16 bits = 2 bytes por sample
    const sampleRate = 16000;
    const bytesPerSample = 2;
    const silenceSamples = Math.floor((durationMs / 1000) * sampleRate);
    const silenceBytes = silenceSamples * bytesPerSample;
    
    // Cria buffer de silêncio (0 para PCM)
    const silenceBuffer = Buffer.alloc(silenceBytes, 0);
    
    // Concatena silêncio + áudio original
    return Buffer.concat([silenceBuffer, audioBuffer]);
  } catch (err) {
    console.error('Erro ao adicionar silêncio inicial:', err);
    return audioBuffer;
  }
}

// ----------------------------------------------------
// CONVERTER WAV PARA OGG (OPUS)
// ----------------------------------------------------

async function converterParaOgg(audioBuffer) {
  // Nota: Para produção, você precisaria instalar e usar uma biblioteca como:
  // - fluent-ffmpeg
  // - @discordjs/opus
  // - ou um serviço externo
  
  // Por enquanto, retorna como WAV
  // Em produção, implemente a conversão aqui
  return {
    buffer: audioBuffer,
    extension: 'wav',
    contentType: 'audio/wav'
  };
}

// ----------------------------------------------------
// SALVAR ÁUDIO NO CLOUDFLARE R2
// ----------------------------------------------------

async function salvarNoR2(buffer, userId = 'anonimo', options = {}) {
  if (!R2_BUCKET || !R2_PUBLIC_BASE_URL) {
    throw new Error('Config R2 faltando (R2_BUCKET ou R2_PUBLIC_BASE_URL)');
  }

  const { extension = 'wav', contentType = 'audio/wav' } = options;

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

  const audioResponse = await axios.get(audioUrl, {
    responseType: 'arraybuffer'
  });

  const audioBuffer = Buffer.from(audioResponse.data);

  const formData = new FormData();
  formData.append('file', audioBuffer, 'audio.wav');
  formData.append('model', 'whisper-1');
  formData.append('language', 'pt'); // Força português
  formData.append('response_format', 'json');
  formData.append('temperature', 0.2);

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
    // 1) Ajusta o texto para fala humanizada em pt-BR
    const textoAjustado = await ajustarTextoParaFalaPtBR(texto);

    console.log('Texto original:', texto);
    console.log('Texto humanizado (pt-BR):', textoAjustado);

    // 2) Gera o áudio com ElevenLabs otimizado para pt-BR
    let audioBuffer;
    try {
      audioBuffer = await gerarAudioElevenLabsPtBR(textoAjustado);
    } catch (errEleven) {
      console.error('Falha ElevenLabs TTS pt-BR:', errEleven?.message || errEleven);
      throw new Error(`Falha ao gerar áudio em português brasileiro: ${errEleven.message}`);
    }

    // 3) Adiciona silêncio/respiro no início
    audioBuffer = adicionarSilencioInicial(audioBuffer, SILENCE_DURATION_MS);
    console.log(`Silêncio inicial de ${SILENCE_DURATION_MS}ms adicionado`);

    // 4) Converte para formato apropriado
    const audioConvertido = await converterParaOgg(audioBuffer);

    // 5) Salva o áudio no Cloudflare R2
    const { uri, size } = await salvarNoR2(audioConvertido.buffer, userId, {
      extension: audioConvertido.extension,
      contentType: audioConvertido.contentType
    });

    // 6) Retorna para o chamador
    return res.json({
      uri,
      type: audioConvertido.contentType,
      size,
      textoProcessado: textoAjustado,
      idioma: 'pt-BR',
      voz: 'Roberta (ElevenLabs)'
    });
  } catch (err) {
    console.error('Erro no /tts:', err?.response?.data || err.message || err);
    return res.status(err?.response?.status || 500).json({ 
      error: err.message || 'Erro ao gerar áudio',
      detalhes: err?.response?.data ? JSON.stringify(err.response.data).substring(0, 200) : null
    });
  }
});

// POST /stt  -> áudio (URL) -> texto
app.post('/stt', async (req, res) => {
  const { audioUrl } = req.body;

  if (!audioUrl) {
    return res.status(400).json({ error: 'Campo "audioUrl" é obrigatório' });
  }

  try {
    const texto = await transcreverAudioWhisperFromUrl(audioUrl);
    return res.json({ texto, idioma: 'pt-BR' });
  } catch (err) {
    console.error('Erro no /stt:', err?.response?.data || err.message || err);
    return res.status(500).json({ error: 'Erro ao transcrever áudio' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'online',
    tts: 'ElevenLabs pt-BR',
    ajusteTexto: OPENAI_API_KEY ? 'OpenAI GPT' : 'Desativado',
    stt: OPENAI_API_KEY ? 'OpenAI Whisper' : 'Desativado'
  });
});

// ----------------------------------------------------
// INÍCIO DO SERVIDOR
// ----------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API de voz humanizada (pt-BR) rodando na porta ${PORT}`);
  console.log('========================================');
  console.log('CONFIGURAÇÕES PARA PORTUGUÊS BRASILEIRO:');
  console.log('- Voz: Roberta (ElevenLabs)');
  console.log('- Modelo: eleven_multilingual_v2 (otimizado para pt-BR)');
  console.log('- Idioma: pt-br (português brasileiro)');
  console.log('- Formato: WAV/PCM 16kHz (alta qualidade)');
  console.log('- Silêncio inicial:', SILENCE_DURATION_MS + 'ms');
  console.log('- Humanização: Expressões e vocabulário brasileiros');
  console.log('========================================');
});
