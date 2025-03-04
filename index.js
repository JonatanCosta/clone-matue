const Alexa = require('ask-sdk-core');
const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const ffmpegPath = require('ffmpeg-static');


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

        // Cria um array para coletar os dados da saída
        const outputChunks = [];

        // Inicia o processo FFmpeg com os parâmetros desejados
        const ffmpegProcess = spawn(ffmpegPath, [
            '-f', 'mp3',      // formato de entrada
            '-i', 'pipe:0',   // ler da entrada padrão
            '-b:a', '48k',    // bitrate de áudio: 48kbps
            '-ar', '22050',   // sample rate: 22050 Hz
            '-f', 'mp3',      // formato de saída
            'pipe:1'          // enviar a saída para a saída padrão
        ]);

        ffmpegProcess.stdout.on('data', (chunk) => {
            outputChunks.push(chunk);
        });

        ffmpegProcess.stdout.on('end', () => {
            resolve(Buffer.concat(outputChunks));
        });

        ffmpegProcess.on('error', (err) => {
            reject(err);
        });

        // Encaminha o inputBuffer para o ffmpeg
        passIn.pipe(ffmpegProcess.stdin);
    });
}

// Substitua pelas suas chaves
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const BUCKET_NAME = process.env.BUCKET_NAME;

// Configuração do S3
const s3 = new AWS.S3({
    region: "sa-east-1"
});

const LaunchRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
    },
    handle(handlerInput) {
        const welcomeAudioUrl = 'https://john-codes.s3.sa-east-1.amazonaws.com/matue-tts/boas_vindas_alexa.mp3';
        const speakOutput = `<speak><audio src="${welcomeAudioUrl}"/></speak>`;
        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(`<speak>Qual é a boa?</speak>`)
            .withShouldEndSession(false)  // Mantém a sessão ativa
            .getResponse();
    }
};

const ChatIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'ChatIntent';
    },
    async handle(handlerInput) {
        const query = Alexa.getSlotValue(handlerInput.requestEnvelope, 'query') || '';
        console.log("Slot 'query':", query);

        try {
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

            console.log("Resposta do OpenAI:", botReply);
            console.log("Iniciando chamada à ElevenLabs", ELEVENLABS_API_KEY);

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
                const errorData = await ttsResponse.json();
                console.error("Erro ElevenLabs: ", errorData);
                return handlerInput.responseBuilder
                    .speak("Desculpe, ocorreu um erro ao gerar o áudio.")
                    .withShouldEndSession(false)
                    .getResponse();
            }

            console.log("Chamada à ElevenLabs concluída");
            const audioBuffer = await ttsResponse.buffer();
            console.log("Áudio gerado pela ElevenLabs com sucesso!");
            const reencodedBuffer = await reencodeAudio(audioBuffer);
            console.log("Gerou o reencodedBuffer");

            const audioKey = `matue-tts/tts/${uuidv4()}.mp3`;
            await s3.putObject({
                Bucket: BUCKET_NAME,
                Key: audioKey,
                Body: reencodedBuffer,
                ContentType: "audio/mpeg",
                ACL: "public-read"
            }).promise();

            const audioURL = `https://${BUCKET_NAME}.s3.sa-east-1.amazonaws.com/${audioKey}`;
            console.log("URL de audio gerada: ", audioURL);

            const speechOutput = `<speak><audio src="${audioURL}" /></speak>`;
            return handlerInput.responseBuilder
                .speak(speechOutput)
                .withSimpleCard('Matuê', botReply)
                .reprompt('Qual é a boa?')  // Reprompt para manter a sessão ativa
                .withShouldEndSession(false)
                .getResponse();
        } catch (error) {
            console.error("Erro geral:", error);
            return handlerInput.responseBuilder
                .speak("Desculpe, ocorreu um erro ao processar sua solicitação.")
                .reprompt("Pode repetir, por favor?")
                .withShouldEndSession(false)
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
            .withShouldEndSession(false)
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
            .withShouldEndSession(true)
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
            .withShouldEndSession(false)
            .getResponse();
    }
};

const SessionEndedRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder.getResponse();
    }
};

const ErrorHandler = {
    canHandle() {
        return true;
    },
    handle(handlerInput, error) {
        console.error("Erro capturado:", error);
        const speakOutput = 'Desculpe, ocorreu um erro. Por favor, tente novamente.';
        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .withShouldEndSession(false)
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

console.log("Evento recebido:", JSON.stringify({/* seu exemplo de payload */}, null, 2));