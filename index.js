const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode-terminal');
const http = require('http');
const axios = require('axios');

const app = express();
app.use(express.json());

// --- CONFIGURAÇÕES VINDAS DO RENDER ---
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const API_KEY = process.env.API_KEY;
const PORT = process.env.PORT || 3000;

if (!N8N_WEBHOOK_URL || !API_KEY) {
    console.error("ERRO: As variáveis de ambiente N8N_WEBHOOK_URL e API_KEY são obrigatórias!");
    process.exit(1);
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    console.log(`Usando Baileys v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state,
        browser: ['Gemini-Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('QR Code recebido, escaneie por favor:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada, motivo:', lastDisconnect.error, ', reconectando:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp conectado com sucesso!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            console.log('Mensagem recebida:', JSON.stringify(msg, null, 2));
            try {
                await axios.post(N8N_WEBHOOK_URL, msg, { headers: { 'Content-Type': 'application/json' }});
                console.log('Mensagem enviada para o webhook do n8n.');
            } catch (error) {
                console.error('Erro ao enviar mensagem para o n8n:', error.message);
            }
        }
    });

    // Endpoint para o n8n enviar respostas
    app.post('/send', async (req, res) => {
        const apiKey = req.headers['x-api-key'];
        if (apiKey !== API_KEY) {
            return res.status(401).json({ error: 'Chave de API inválida' });
        }

        const { to, message } = req.body;
        if (!to || !message) {
            return res.status(4.00).json({ error: 'Parâmetros "to" e "message" são obrigatórios' });
        }

        try {
            const jid = `${to}@s.whatsapp.net`;
            await sock.sendMessage(jid, { text: message });
            console.log(`Mensagem enviada para ${to}`);
            res.status(200).json({ success: true, message: 'Mensagem enviada' });
        } catch (error) {
            console.error('Erro ao enviar mensagem:', error);
            res.status(500).json({ success: false, error: 'Falha ao enviar mensagem' });
        }
    });
}

// Inicia o servidor e a conexão
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    connectToWhatsApp();
});
