require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const mongoose = require('mongoose');
const cron = require('node-cron');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ============================================
// CONFIGURAÇÕES
// ============================================
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;

// ============================================
// CONEXÃO MONGODB
// ============================================
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB conectado'))
    .catch(err => console.error('❌ Erro MongoDB:', err));

// ============================================
// MODELS
// ============================================
const LeadSchema = new mongoose.Schema({
    source: { type: String, enum: ['google_maps', 'instagram', 'cnpj', 'manual'] },
    businessName: String,
    phone: String,
    email: String,
    address: String,
    city: String,
    state: String,
    category: String,
    website: String,
    rating: Number,
    score: { type: Number, default: 50 },
    status: { 
        type: String, 
        enum: ['new', 'contacted', 'engaged', 'qualified', 'converted', 'lost'],
        default: 'new'
    },
    capturedAt: { type: Date, default: Date.now },
    lastContactAt: Date,
    conversationHistory: [{
        sender: { type: String, enum: ['bot', 'lead', 'human'] },
        message: String,
        timestamp: { type: Date, default: Date.now }
    }]
});

const Lead = mongoose.model('Lead', LeadSchema);

// ============================================
// CLASSE: GOOGLE MAPS SCRAPER
// ============================================
class GoogleMapsScraper {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }

    async searchLeads(query, location, radius = 5000) {
        try {
            const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
            const response = await axios.get(url, {
                params: {
                    query: `${query} em ${location}`,
                    key: this.apiKey,
                    radius: radius,
                    language: 'pt-BR'
                }
            });

            const leads = [];
            for (const place of response.data.results.slice(0, 20)) {
                const details = await this.getPlaceDetails(place.place_id);
                
                leads.push({
                    source: 'google_maps',
                    businessName: place.name,
                    phone: this.extractPhone(details),
                    address: place.formatted_address,
                    rating: place.rating,
                    website: details.website,
                    score: this.calculateScore(place, details),
                    status: 'new'
                });

                await this.sleep(500);
            }

            return leads;
        } catch (error) {
            console.error('Erro ao buscar leads:', error.message);
            return [];
        }
    }

    async getPlaceDetails(placeId) {
        try {
            const url = 'https://maps.googleapis.com/maps/api/place/details/json';
            const response = await axios.get(url, {
                params: {
                    place_id: placeId,
                    fields: 'formatted_phone_number,website,opening_hours',
                    key: this.apiKey
                }
            });
        } catch (error) {
            return {};
        }
    }

    extractPhone(details) {
    }

    calculateScore(place, details) {
        let score = 50;
        if (place.rating >= 4.5) score += 15;
        if (place.user_ratings_total > 50) score += 10;
        if (details.website) score += 15;
        if (details.formatted_phone_number) score += 10;
        return Math.min(score, 100);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============================================
// CLASSE: IA CONVERSACIONAL
// ============================================
class ConversationalAI {
    constructor(apiKey) {
        this.anthropic = new Anthropic({ apiKey });
    }

    async generateFirstMessage(lead) {
        try {
            const prompt = `
Você é um assistente de vendas consultivo.

LEAD:
- Nome: ${lead.businessName}
- Localização: ${lead.address}
- Categoria: ${lead.category}
- Rating: ${lead.rating}/5

Crie uma mensagem inicial de WhatsApp:
- Máximo 2 linhas
- Personalizada com dados do lead
- Tom amigável e não-invasivo
- Inclua pergunta que gere resposta

Exemplo: "Oi João! Vi que você tem a pizzaria no Centro. Como está a divulgação digital aí?"

Mensagem:`;

            const response = await this.anthropic.messages.create({
                model: 'claude-3-5-sonnet-20241022',
                max_tokens: 200,
                messages: [{ role: 'user', content: prompt }]
            });

            return response.content[0].text.trim();
        } catch (error) {
            console.error('Erro ao gerar mensagem:', error.message);
            return `Olá! Vi seu negócio ${lead.businessName}. Posso te ajudar com marketing digital?`;
        }
    }

    async respondToMessage(lead, incomingMessage) {
        try {
            const history = lead.conversationHistory
                .map(m => `[${m.sender}]: ${m.message}`)
                .join('\n');

            const prompt = `
Histórico:
${history}

Nova mensagem do lead: "${incomingMessage}"

Responda de forma natural, consultiva e amigável. Máximo 3 linhas.`;

            const response = await this.anthropic.messages.create({
                model: 'claude-3-5-sonnet-20241022',
                max_tokens: 300,
                messages: [{ role: 'user', content: prompt }]
            });

            return response.content[0].text.trim();
        } catch (error) {
            console.error('Erro ao responder:', error.message);
            return 'Obrigado pela mensagem! Em breve retorno.';
        }
    }
}

// ============================================
// CLASSE: WHATSAPP MANAGER
// ============================================
class WhatsAppManager {
    constructor(apiUrl, apiKey, instance) {
        this.apiUrl = apiUrl;
        this.apiKey = apiKey;
        this.instance = instance;
    }

    async sendMessage(phone, message) {
        try {
            const formattedPhone = this.formatPhone(phone);
            
            const response = await axios.post(
                `${this.apiUrl}/message/sendText/${this.instance}`,
                {
                    number: formattedPhone,
                    text: message
                },
                {
                    headers: {
                        'apikey': this.apiKey,
                        'Content-Type': 'application/json'
                    }
                }
            );

            return response.status === 200;
        } catch (error) {
            console.error('Erro ao enviar WhatsApp:', error.message);
            return false;
        }
    }

    formatPhone(phone) {
        const cleaned = phone.replace(/\D/g, '');
        return cleaned.startsWith('55') ? cleaned : `55${cleaned}`;
    }
}

// ============================================
// INICIALIZAÇÃO DOS SERVIÇOS
// ============================================
const googleScraper = new GoogleMapsScraper(GOOGLE_MAPS_KEY);
const conversationalAI = new ConversationalAI(ANTHROPIC_KEY);
const whatsappManager = new WhatsAppManager(EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE);

// ============================================
// ROTAS DA API
// ============================================

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'online',
        message: '🚀 LeadGenius AI está rodando!',
        timestamp: new Date()
    });
});

// Capturar leads do Google Maps
app.post('/api/capture/google-maps', async (req, res) => {
    try {
        const { query, location, radius } = req.body;
        
            return res.status(400).json({ 
                error: 'Query e location são obrigatórios' 
            });
        }

        console.log(`🔍 Buscando leads: ${query} em ${location}`);
        
        const leads = await googleScraper.searchLeads(query, location, radius);
        
        const savedLeads = await Lead.insertMany(leads);
        
        res.json({
            success: true,
            message: `${savedLeads.length} leads capturados`,
            leads: savedLeads
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Enviar mensagens para leads
app.post('/api/engage/send-messages', async (req, res) => {
    try {
        const { minScore = 60, limit = 10 } = req.body;
        
        const leads = await Lead.find({
            status: 'new',
            score: { $gte: minScore },
            phone: { $exists: true, $ne: null }
        }).limit(limit);

        console.log(`💬 Enviando mensagens para ${leads.length} leads`);

        const results = [];
        
        for (const lead of leads) {
            const message = await conversationalAI.generateFirstMessage(lead);
            
            const sent = await whatsappManager.sendMessage(lead.phone, message);
            
            if (sent) {
                lead.status = 'contacted';
                lead.lastContactAt = new Date();
                lead.conversationHistory.push({
                    sender: 'bot',
                    message: message,
                    timestamp: new Date()
                });
                await lead.save();
                
                results.push({ lead: lead.businessName, sent: true });
                console.log(`✅ Mensagem enviada: ${lead.businessName}`);
            } else {
                results.push({ lead: lead.businessName, sent: false });
            }

            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        res.json({
            success: true,
            message: `Mensagens processadas`,
            results: results
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Webhook para receber mensagens do WhatsApp
app.post('/api/webhook/whatsapp', async (req, res) => {
    try {
        const { data } = req.body;
        
            return res.status(200).send('OK');
        }

        const phone = data.key.remoteJid.replace('@s.whatsapp.net', '');

        const lead = await Lead.findOne({ 
            phone: { $regex: phone.slice(-8) } 
        });

        if (!lead) {
            return res.status(200).send('OK');
        }

        console.log(`📩 Mensagem recebida de ${lead.businessName}: ${incomingMessage}`);

        lead.conversationHistory.push({
            sender: 'lead',
            message: incomingMessage,
            timestamp: new Date()
        });

        const response = await conversationalAI.respondToMessage(lead, incomingMessage);

        await whatsappManager.sendMessage(lead.phone, response);

        lead.conversationHistory.push({
            sender: 'bot',
            message: response,
            timestamp: new Date()
        });

        lead.status = 'engaged';
        await lead.save();

        console.log(`✅ Resposta enviada: ${response}`);

        res.status(200).send('OK');
    } catch (error) {
        console.error('Erro no webhook:', error.message);
        res.status(200).send('OK');
    }
});

// Listar leads
app.get('/api/leads', async (req, res) => {
    try {
        const { status, minScore, limit = 50 } = req.query;
        
        const filter = {};
        if (status) filter.status = status;
        if (minScore) filter.score = { $gte: parseInt(minScore) };

        const leads = await Lead.find(filter)
            .sort({ score: -1, capturedAt: -1 })
            .limit(parseInt(limit));

        res.json({
            success: true,
            total: leads.length,
            leads: leads
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Estatísticas
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const totalLeads = await Lead.countDocuments();
        const newLeads = await Lead.countDocuments({ status: 'new' });
        const contacted = await Lead.countDocuments({ status: 'contacted' });
        const engaged = await Lead.countDocuments({ status: 'engaged' });
        const converted = await Lead.countDocuments({ status: 'converted' });

        const avgScore = await Lead.aggregate([
            { $group: { _id: null, avgScore: { $avg: '$score' } } }
        ]);

        res.json({
            success: true,
            stats: {
                totalLeads,
                newLeads,
                contacted,
                engaged,
                converted,
                conversionRate: totalLeads > 0 ? ((converted / totalLeads) * 100).toFixed(2) : 0,
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// AUTOMAÇÃO: CAPTURA DIÁRIA (CRON JOB)
// ============================================
cron.schedule('0 9 * * *', async () => {
    console.log('🤖 Executando captura automática diária...');
    
    try {
        const leads = await googleScraper.searchLeads(
            'clínicas de estética',
            'São Paulo',
            10000
        );
        
        await Lead.insertMany(leads);
        console.log(`✅ ${leads.length} leads capturados automaticamente`);
    } catch (error) {
        console.error('Erro na captura automática:', error.message);
    }
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
    console.log(`
    ╔═══════════════════════════════════════╗
    ║  🚀 LeadGenius AI - Servidor Online  ║
    ╠═══════════════════════════════════════╣
    ║  📡 Porta: ${PORT}                     
    ║  🗄️  MongoDB: Conectado               
    ║  🤖 IA: Claude Sonnet                 
    ║  💬 WhatsApp: Evolution API           
    ╚═══════════════════════════════════════╝
    `);
});
