const Alexa = require('ask-sdk-core');
const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const { PassThrough } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

ffmpeg.setFfmpegPath(ffmpegStatic.path);
ffmpeg.setFfprobePath(ffprobeStatic.path);

/**
 * Função para reencodar o áudio usando fluent-ffmpeg
 * - Ajusta bitrate para 48 kbps
 * - Ajusta sample rate para 22050 Hz
 */
function reencodeAudio(inputBuffer) {
    return new Promise((resolve, reject) => {
        // Cria um stream de leitura a partir do buffer
        const passIn = new PassThrough();
        passIn.end(inputBuffer);

        // Cria um outro PassThrough para receber a saída do ffmpeg
        const passOut = new PassThrough();
        const chunks = [];

        // Coletar dados do output do ffmpeg
        passOut.on('data', (chunk) => {
            chunks.push(chunk);
        });
        passOut.on('end', () => {
            resolve(Buffer.concat(chunks));
        });
        passOut.on('error', (err) => {
            reject(err);
        });

        // Configura o ffmpeg para ler do passIn (formato MP3),
        // reduzir bitrate para 48kbps e sample rate 22050
        ffmpeg(passIn)
            .inputFormat('mp3')
            .audioBitrate('48k')
            .audioFrequency(22050)
            .format('mp3')
            .on('error', (err) => {
                reject(err);
            })
            // Direciona a saída para passOut
            .pipe(passOut, { end: true });
    });
}

// Substitua pelas suas chaves
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const BUCKET_NAME = process.env.BUCKET_NAME;

// Configuração do S3
const s3 = new AWS.S3({
    region: "sa-east-1",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

/**
 * Handler chamado quando o usuário inicia a skill sem mencionar um intent específico
 * Ex: "Alexa, abra modo matue"
 */
const LaunchRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
    },
    handle(handlerInput) {
        // Ao iniciar a skill, vamos reproduzir o áudio de boas-vindas armazenado no S3
        const welcomeAudioUrl = 'https://john-codes.s3.sa-east-1.amazonaws.com/matue-tts/boas_vindas_alexa.mp3';

        // Retorna a resposta em SSML com o <audio> do S3
        const speakOutput = `<speak><audio src="${welcomeAudioUrl}"/></speak>`;
        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt('Qual é a boa?')
            .getResponse();
    }
};

const ChatIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'ChatIntent';
    },
    async handle(handlerInput) {
        // Extrai o texto do usuário (slot "query")
        const query = Alexa.getSlotValue(handlerInput.requestEnvelope, 'query') || '';

        try {
            // 1. Chamada ao OpenAI para obter resposta no estilo Matuê
            const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${OPENAI_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "gpt-4",
                    messages: [
                        {
                            role: "system",
                            content: "Você é um clone do rapper Matuê. Responda sempre com o estilo do Matuê, utilizando suas gírias e seu jeito de falar. Responda apenas perguntas que estejam dentro do universo do Matuê; caso a pergunta não seja pertinente, responda 'Não faço parte desse universo, meu mano.'"
                        },
                        { role: "user", content: query }
                    ]
                })
            });
            const openaiData = await openaiResponse.json();
            const botReply = openaiData.choices[0].message.content;

            // 2. Chamada ao ElevenLabs para gerar o MP3 (como buffer)
            const ttsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_22050_32`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "xi-api-key": ELEVENLABS_API_KEY
                },
                body: JSON.stringify({
                    text: botReply,
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 1,
                        use_speaker_boost: false
                    },
                    model_id: "eleven_multilingual_v2",
                    output_format: "mp3_22050_32"
                })
            });

            if (!ttsResponse.ok) {
                // Se ocorrer erro na API do ElevenLabs
                const errorData = await ttsResponse.json();
                console.error("Erro ElevenLabs: ", errorData);
                return handlerInput.responseBuilder
                    .speak("Desculpe, ocorreu um erro ao gerar o áudio.")
                    .getResponse();
            }

            // buffer do MP3 gerado pela ElevenLabs
            const audioBuffer = await ttsResponse.buffer();

            // 2.1. Reencodar para garantir compatibilidade com Alexa (48 kbps, 22050 Hz)
            const reencodedBuffer = await reencodeAudio(audioBuffer);

            // 3. Subir o arquivo no S3 com um nome único (UUID)
            const audioKey = `matue-tts/tts/${uuidv4()}.mp3`;
            await s3.putObject({
                Bucket: BUCKET_NAME,
                Key: audioKey,
                Body: reencodedBuffer,
                ContentType: "audio/mpeg",
                ACL: "public-read"
            }).promise();

            // 4. Criar a URL pública do arquivo
            const audioURL = `https://${BUCKET_NAME}.s3.sa-east-1.amazonaws.com/${audioKey}`;

            console.log("URL de audio gerada: ", audioURL);

            // 5. Montar SSML para Alexa reproduzir o áudio
            const speechOutput = `
                <speak>
                    Resposta do Matue:
                    <audio src="${audioURL}" />
                </speak>
            `;

            return handlerInput.responseBuilder
                .speak(speechOutput)
                .withSimpleCard('Matuê', botReply)
                .getResponse();

        } catch (error) {
            console.error("Erro geral:", error);
            return handlerInput.responseBuilder
                .speak("Desculpe, ocorreu um erro ao processar sua solicitação.")
                .getResponse();
        }
    }
};

const HelpIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        const speakOutput = 'Você pode dizer algo como: "Pergunte ao Matuê qual a boa."';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};

const CancelAndStopIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && (
                Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.CancelIntent'
                || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StopIntent'
            );
    },
    handle(handlerInput) {
        const speakOutput = 'Valeu, falou!';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .getResponse();
    }
};

const FallbackIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
    },
    handle(handlerInput) {
        const speakOutput = 'Desculpe, não entendi bem. Pode tentar de novo?';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};

const SessionEndedRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
    },
    handle(handlerInput) {
        // Lógica de finalização, se necessário
        return handlerInput.responseBuilder.getResponse();
    }
};

const ErrorHandler = {
    canHandle() {
        return true;
    },
    handle(handlerInput, error) {
        console.error(`Erro capturado: ${error.message}`);
        const speakOutput = 'Desculpe, ocorreu um erro. Por favor, tente novamente.';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};

exports.handler = Alexa.SkillBuilders.custom()
    .addRequestHandlers(
        LaunchRequestHandler,
        ChatIntentHandler,
        HelpIntentHandler,
        CancelAndStopIntentHandler,
        FallbackIntentHandler,
        SessionEndedRequestHandler
    )
    .addErrorHandlers(ErrorHandler)
    .lambda();