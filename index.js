const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const qrcode = require('qrcode');
require('dotenv').config();

// Configuración
const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://localhost:8000';
const SALES_DEPARTMENT_NUMBER = process.env.SALES_DEPARTMENT_NUMBER || '18497201998';
const PORT = process.env.PORT || 3000;

// Crear servidor Express y configurar socket.io
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Variable para almacenar el último QR generado
let lastQr = null;
let clientStatus = 'offline';

// Servir archivos estáticos
app.use(express.static('public'));

// Ruta principal que muestra la página QR
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>WhatsApp Bot QR</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body {
                font-family: Arial, sans-serif;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100vh;
                margin: 0;
                background-color: #f5f5f5;
            }
            .container {
                text-align: center;
                background-color: white;
                padding: 30px;
                border-radius: 10px;
                box-shadow: 0 0 10px rgba(0,0,0,0.1);
                max-width: 90%;
            }
            #qrcode {
                margin: 20px auto;
            }
            .status {
                margin-top: 20px;
                padding: 10px;
                border-radius: 5px;
                font-weight: bold;
            }
            .offline {
                background-color: #ffcccc;
                color: #990000;
            }
            .loading {
                background-color: #fff9c4;
                color: #6d4c41;
            }
            .ready {
                background-color: #c8e6c9;
                color: #2e7d32;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>WhatsApp Bot - Código QR</h1>
            <p>Escanea este código con WhatsApp para iniciar sesión</p>
            <div id="qrcode"></div>
            <div id="status" class="status offline">Estado: Esperando QR...</div>
        </div>

        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            const qrDiv = document.getElementById('qrcode');
            const statusDiv = document.getElementById('status');

            socket.on('qr', (qr) => {
                qrDiv.innerHTML = qr;
                statusDiv.innerHTML = 'Estado: QR listo para escanear';
                statusDiv.className = 'status loading';
            });

            socket.on('status', (status) => {
                switch(status) {
                    case 'ready':
                        statusDiv.innerHTML = 'Estado: ¡Conectado! El bot está funcionando';
                        statusDiv.className = 'status ready';
                        qrDiv.innerHTML = '<p>WhatsApp conectado correctamente</p>';
                        break;
                    case 'offline':
                        statusDiv.innerHTML = 'Estado: Desconectado';
                        statusDiv.className = 'status offline';
                        break;
                    default:
                        statusDiv.className = 'status loading';
                }
            });

            // Verificar si ya hay un QR o estado disponible al cargar la página
            socket.emit('requestQR');
        </script>
    </body>
    </html>
    `);
});

// Cuando un cliente se conecta al socket
io.on('connection', (socket) => {
    console.log('Cliente web conectado');
    
    // Si alguien se conecta y ya tenemos un QR, enviarlo
    if (lastQr) {
        socket.emit('qr', lastQr);
    }
    
    // Enviar el estado actual
    socket.emit('status', clientStatus);
    
    // Si el cliente solicita el QR actual
    socket.on('requestQR', () => {
        if (lastQr) {
            socket.emit('qr', lastQr);
        }
        socket.emit('status', clientStatus);
    });
    
    socket.on('disconnect', () => {
        console.log('Cliente web desconectado');
    });
});

// Inicializar el cliente de WhatsApp
console.log('Iniciando servicio de WhatsApp...');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox']
    }
});

// Generar código QR para escanear
client.on('qr', async (qr) => {
    console.log('Nuevo QR recibido');
    
    try {
        // Generar imagen QR como data URL
        const qrImage = await qrcode.toDataURL(qr);
        lastQr = `<img src="${qrImage}" alt="QR Code">`;
        
        // Enviar a todos los clientes conectados
        io.emit('qr', lastQr);
        io.emit('status', 'qr-received');
        
        clientStatus = 'qr-received';
        
        // También mostrar en consola para depuración
        console.log('QR disponible en la web: http://localhost:' + PORT);
    } catch (error) {
        console.error('Error al generar QR:', error);
    }
});

client.on('ready', () => {
    console.log('Cliente WhatsApp está listo y conectado!');
    clientStatus = 'ready';
    io.emit('status', 'ready');
});

client.on('authenticated', () => {
    console.log('AUTENTICADO');
    clientStatus = 'authenticated';
    io.emit('status', 'authenticated');
});

client.on('auth_failure', msg => {
    console.error('Error de autenticación', msg);
    clientStatus = 'auth_failure';
    io.emit('status', 'auth_failure');
});

client.on('disconnected', () => {
    console.log('Cliente WhatsApp desconectado');
    clientStatus = 'offline';
    io.emit('status', 'offline');
});

// Manejar mensajes entrantes
client.on('message', async msg => {
    const chat = await msg.getChat();
    
    // Solo procesar mensajes directos, no de grupos
    if (!chat.isGroup) {
        // Obtener información del contacto
        const contact = await msg.getContact();
        const phoneNumber = contact.number;
        const messageContent = msg.body;
        
        console.log(`Mensaje recibido de ${phoneNumber}: ${messageContent}`);
        
        // Manejar respuestas del departamento de ventas (formato: #precio query_id info_precio)
        if (phoneNumber === SALES_DEPARTMENT_NUMBER && messageContent.startsWith('#precio')) {
            await handlePriceResponse(msg, messageContent);
            return;
        }
        
        // Indicar que está escribiendo
        chat.sendStateTyping();
        
        try {
            // Enviar mensaje al API Python
            const response = await axios.post(`${PYTHON_API_URL}/chat`, {
                question: messageContent,
                phone_number: phoneNumber
            });
            
            // Si es una consulta de precio, reenviar al departamento de ventas
            if (response.data.status === 'price_query' && response.data.forward_to) {
                await forwardToDepartment(response.data);
            }
            
            // Esperar un poco para simular tiempo de escritura natural
            setTimeout(async () => {
                // Enviar respuesta de vuelta a WhatsApp
                if (response.data && response.data.answer) {
                    await msg.reply(response.data.answer);
                    console.log(`Respuesta enviada a ${phoneNumber}`);
                } else {
                    await msg.reply('Lo siento, ocurrió un error al procesar tu mensaje.');
                    console.error('Respuesta de API inválida:', response.data);
                }
            }, 1000);
            
        } catch (error) {
            console.error('Error al comunicarse con el API:', error.message);
            await msg.reply('Lo siento, en este momento no puedo procesar tu mensaje. Intenta más tarde.');
        }
    }
});

// Función para manejar respuestas de precios del departamento de ventas
async function handlePriceResponse(msg, messageContent) {
    try {
        // Formato esperado: #precio query_id información_de_precio
        const parts = messageContent.split(' ');
        
        if (parts.length < 3) {
            await msg.reply('❌ Formato incorrecto. Usa: #precio query_id información_de_precio');
            return;
        }
        
        const query_id = parts[1];
        const price_info = parts.slice(2).join(' ');
        
        console.log(`Procesando respuesta de precio para query_id: ${query_id}`);
        
        // Enviar la respuesta al API Python
        const response = await axios.post(`${PYTHON_API_URL}/price-response`, {
            query_id: query_id,
            price_info: price_info
        });
        
        if (response.data.status === 'success') {
            await msg.reply('✅ Respuesta enviada al cliente correctamente');
            
            // Si la API devuelve el número del cliente, también podemos enviarle directamente el mensaje
            if (response.data.customer_phone && response.data.answer) {
                const customerNumber = `${response.data.customer_phone}@c.us`;
                try {
                    // Verificar si podemos enviar mensajes a este número
                    const chat = await client.getChatById(customerNumber);
                    if (chat) {
                        await chat.sendMessage(response.data.answer);
                        console.log(`Mensaje enviado directamente al cliente ${response.data.customer_phone}`);
                    }
                } catch (error) {
                    console.error(`No se pudo enviar mensaje directo al cliente: ${error.message}`);
                }
            }
        } else {
            await msg.reply(`❌ Error: ${response.data.message}`);
        }
    } catch (error) {
        console.error('Error procesando respuesta de precio:', error.message);
        await msg.reply('❌ Error al procesar la respuesta. Inténtalo nuevamente.');
    }
}

// Función para reenviar consultas al departamento de ventas
async function forwardToDepartment(data) {
    try {
        const departmentId = `${data.forward_to}@c.us`;
        
        console.log(`Intentando reenviar mensaje a ${departmentId}`);
        
        // Verificar que podemos enviar mensajes a este número
        try {
            const chat = await client.getChatById(departmentId);
            if (chat) {
                await chat.sendMessage(data.forward_message);
                console.log(`Consulta de precio reenviada al departamento de ventas: ${data.forward_to}`);
                return true;
            }
        } catch (error) {
            console.error(`Error al reenviar al departamento: ${error.message}`);
            
            // Intento alternativo si getChatById falla
            try {
                await client.sendMessage(departmentId, data.forward_message);
                console.log(`Consulta reenviada usando método alternativo a: ${data.forward_to}`);
                return true;
            } catch (err) {
                console.error(`Método alternativo también falló: ${err.message}`);
            }
        }
        
        console.error(`No se pudo reenviar la consulta al departamento: ${data.forward_to}`);
        return false;
    } catch (error) {
        console.error('Error general al reenviar consulta:', error);
        return false;
    }
}

// Iniciar servidor web
server.listen(PORT, () => {
    console.log(`Servidor web iniciado en http://localhost:${PORT}`);
});

// Iniciar el cliente de WhatsApp
client.initialize();

// Manejar cierre del proceso
process.on('SIGINT', async () => {
    console.log('Cerrando cliente de WhatsApp...');
    await client.destroy();
    process.exit(0);
});