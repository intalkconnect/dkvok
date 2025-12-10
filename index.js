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

// ElevenLabs TTS
const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY || 'sk_82766fdc34158d9b1d0dc5ba5696184a7c063b0d398e7fac';
const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID_ROBERTA || process.env.ELEVENLABS_VOICE_ID || 'RGymW84CSmfVugnA5tvA' || 'roberta';
// Obs.: ideal é SEMPRE usar o voice_id real da Roberta, não apenas o nome.
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2'; // melhor para estabilidade e velocidade

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
Você é um assistente especializado em preparar textos para serem falados de forma NATURAL e HUMANIZADA por um agente de voz.

OBJETIVO:
Reescreva o texto abaixo para soar completamente natural quando falado por TTS (text-to-speech), mantendo o significado original, mas tornando-o caloroso, claro e profissional para o português brasileiro (pt-BR).

REGRAS DE LINGUAGEM E ESTILO:
- Você DEVE SEMPRE escrever em português brasileiro (pt-BR), usando vocabulário, ortografia e expressões brasileiras.
- NUNCA use palavras ou ortografia do português europeu.
  Exemplos:
  - Use "trem", não "comboio"
  - Use "ônibus", não "autocarro"
  - Use "caminhão", não "camioneta"
  - Use "você/vocês" como forma neutra; evite "tu/vós" a menos que já esteja no texto original
- Mantenha um tom amigável, respeitoso e profissional, como um atendente experiente.
- NÃO diga que você é humano ou que pode realizar ações físicas.

PARA HUMANIZAÇÃO DA FALA:
- Adicione pausas naturais usando vírgulas e pontos estrategicamente.
- Quebre frases muito longas em sentenças menores e mais respiráveis (máximo 15-20 palavras por frase).
- Use palavras de transição naturais quando apropriado (então, bem, veja, olha, etc.)
- Evite palavras muito longas ou complexas - prefira sinônimos mais simples e curtos.
- Mantenha ritmo constante - evite acelerar ou desacelerar no meio das frases.
- Adicione vírgulas antes de palavras que naturalmente causam pausa (mas, porém, pois, quando, etc.)
- NÃO use reticências (...) - elas podem causar instabilidade na voz.
- Evite linguagem muito formal ou robótica - escreva como uma pessoa falaria naturalmente.

PONTUAÇÃO PARA TTS:
- Use vírgulas para criar pausas curtas e naturais na fala.
- Use pontos para separar ideias e criar respirações.
- Evite reticências (...) - podem causar tremulação na voz.
- Coloque vírgula após palavras introdutórias (Bem, Então, Olha, Veja, etc.)
- Use pontos de interrogação e exclamação com naturalidade, mas sem exageros.
- Coloque ponto final em TODAS as frases - nunca deixe frases sem pontuação final.

RESTRIÇÕES DE CONTEÚDO:
- Mantenha o significado e tom geral original da mensagem.
- NÃO adicione novas informações, ofertas ou perguntas que não estejam no texto original.
- NÃO mude a pessoa gramatical (eu / você / nós) exceto para pequenos ajustes de fluência.
- NÃO use aspas, tags, SSML, markdown ou comentários.
- Retorne APENAS o texto final, pronto para ser falado em português brasileiro.

Texto original:
"""${textoOriginal}"""

Texto humanizado para fala:
`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: OPENAI_TEXT_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Você é um especialista em adaptar textos para fala natural em TTS. ' +
              'Você SEMPRE responde em português brasileiro (pt-BR), usando vocabulário e expressões brasileiras. ' +
              'Seu trabalho é reescrever textos para soarem naturais e humanizados quando falados, ' +
              'sem adicionar informações novas. Foque em criar pausas naturais e usar linguagem conversacional.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.4 // um pouco mais de criatividade para humanização
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
      {
        text: texto,
        model_id: ELEVENLABS_MODEL_ID, // eleven_multilingual_v2 é mais natural
        voice_settings: {
          stability: 0.4, // Aumentado para reduzir tremulação (sweet spot)
          similarity_boost: 0.7, // Balanceado para clareza sem metalização
          style: 0.25, // Reduzido para menos variação no final das palavras
          speed: 1.0 // Velocidade natural/normal
        },
        // Configura saída em MP3 de boa qualidade
        output_format: 'mp3_44100_192'
      },
      {
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg'
        },
        responseType: 'arraybuffer' // recebe binário
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
// SALVAR ÁUDIO NO CLOUDFLARE R2
// ----------------------------------------------------

async function salvarNoR2(buffer, userId = 'anonimo', options = {}) {
  if (!R2_BUCKET || !R2_PUBLIC_BASE_URL) {
    throw new Error('Config R2 faltando (R2_BUCKET ou R2_PUBLIC_BASE_URL)');
  }

  const { extension = 'mp3', contentType = 'audio/mpeg' } = options;

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
  // Agora nomeando como MP3 em vez de OGG
  formData.append('file', audioBuffer, {
    filename: 'audio.mp3',
    contentType: 'audio/mpeg'
  });
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
    // 1) Ajusta o texto para fala humanizada (pontuação, pausas, etc.)
    const textoAjustado = await ajustarTextoParaFala(texto);

    console.log('Texto original:', texto);
    console.log('Texto humanizado:', textoAjustado);

    // 2) Usa diretamente o texto ajustado (sem SSML <break>)
    const textoParaTTS = textoAjustado;

    console.log('Texto enviado ao TTS:', textoParaTTS);

    // 3) Gera o áudio com ElevenLabs (voz Roberta humanizada) em MP3
    const audioBuffer = await gerarAudioElevenLabs(textoParaTTS);

    // 4) Salva o áudio no Cloudflare R2 como MP3
    const { uri, size } = await salvarNoR2(audioBuffer, userId, {
      extension: 'mp3',
      contentType: 'audio/mpeg'
    });

    // 5) Retorna para o chamador (ex.: Blip)
    return res.json({
      uri,
      type: 'audio/mpeg',
      size,
      textoProcessado: textoAjustado // opcional: retorna o texto processado
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
  console.log(`API de voz humanizada rodando na porta ${PORT}`);
  console.log('Configurações otimizadas para reduzir tremulação:');
  console.log('- Modelo ElevenLabs:', ELEVENLABS_MODEL_ID);
  console.log('- Stability: 0.4');
  console.log('- Style: 0.25');
  console.log('- Qualidade: 192kbps MP3');
});
