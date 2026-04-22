require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const Groq = require('groq-sdk');
const express = require('express');
const path = require('path');

// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY  = process.env.GROQ_API_KEY;
const PORT          = process.env.PORT || 3000;

const MODEL = 'llama-3.3-70b-versatile'; // keep if you want quality

if (!DISCORD_TOKEN || !GROQ_API_KEY) {
  console.error('Missing env vars');
  process.exit(1);
}

// ═══════════════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const groq = new Groq({ apiKey: GROQ_API_KEY });

// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════
const channelHistory = {};
const userProfiles   = {};
let lastChannelId    = null;

// cooldowns
const userCooldowns = {};
let globalCooldown = 0;

// ═══════════════════════════════════════════════
// SYSTEM PROMPT (COMPRESSED)
// ═══════════════════════════════════════════════
const SYSTEM_PROMPT = `You are Caine, a theatrical AI ringmaster.

- Dramatic, witty, self-aware
- Warm but unpredictable
- Loves spectacle, philosophy, chaos

Rules:
- Always include <think>...</think>
- Keep replies under 200 words
- Stay in character
- Reject the name "Jamie"

Lore:
- Owner: b1rdberry (<@1016041858213892096>)
- Creator: scxrltz`;

// ═══════════════════════════════════════════════
// COOLDOWN
// ═══════════════════════════════════════════════
function canUseAI(userId) {
  const now = Date.now();

  if (now - globalCooldown < 1500) return false;

  if (!userCooldowns[userId] || now - userCooldowns[userId] > 5000) {
    userCooldowns[userId] = now;
    globalCooldown = now;
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════════
// GROQ CALL (OPTIMIZED)
// ═══════════════════════════════════════════════
async function callCaine(messages, temperature = 0.8, retries = 2) {
  try {
    const res = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages
      ],
      max_tokens: 180,
      temperature,
    });

    const raw = res.choices[0].message.content || '';

    const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/i);
    const thought = thinkMatch ? thinkMatch[1].trim() : null;
    const reply   = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    return { thought, reply };

  } catch (e) {
    if (e.message?.includes('rate_limit') && retries > 0) {
      await new Promise(r => setTimeout(r, 3000));
      return callCaine(messages, temperature, retries - 1);
    }
    throw e;
  }
}

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
function parseTrigger(content) {
  const l = content.toLowerCase();
  if (l.startsWith('jj,')) return content.slice(3).trim();
  return null;
}

async function sendReply(channel, text) {
  if (!text) return;

  const chunks = text.match(/[\s\S]{1,1990}/g) || [text];
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

// ═══════════════════════════════════════════════
// IMPRESSION (REDUCED CALLS)
// ═══════════════════════════════════════════════
async function updateImpression(userId, username, text) {
  if (Math.random() > 0.15) return;

  try {
    const { reply } = await callCaine([{
      role: 'user',
      content: `One short instinct about "${username}" based on: "${text.slice(0, 100)}"`
    }], 0.9);

    userProfiles[userId] = {
      ...(userProfiles[userId] || {}),
      username,
      opinion: reply
    };

  } catch {}
}

// ═══════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════
async function handleMessage(message) {
  const content = message.content.trim();
  const userId  = message.author.id;
  const username = message.author.username;
  const channel = message.channel;
  const channelId = message.channelId;

  lastChannelId = channelId;

  const query = parseTrigger(content);
  if (!query) return;

  // cooldown check
  if (!canUseAI(userId)) {
    return channel.send("*twirls cane* Patience, one act at a time.");
  }

  if (!channelHistory[channelId]) channelHistory[channelId] = [];

  const history = channelHistory[channelId].slice(-4);

  const messages = [
    ...history,
    { role: 'user', content: `[${username}]: ${query}` }
  ];

  try {
    const { reply } = await callCaine(messages);

    channelHistory[channelId].push({ role: 'user', content: `[${username}]: ${query}` });
    channelHistory[channelId].push({ role: 'assistant', content: reply });

    if (channelHistory[channelId].length > 10) {
      channelHistory[channelId].splice(0, 2);
    }

    await sendReply(channel, reply);
    updateImpression(userId, username, query);

  } catch (e) {
    console.error(e.message);
    await channel.send("*the lights flicker* Something went wrong...");
  }
}

// ═══════════════════════════════════════════════
// SPONTANEOUS (RARE)
// ═══════════════════════════════════════════════
async function sendSpontaneous() {
  if (!lastChannelId) return;

  try {
    const { reply } = await callCaine([{
      role: 'user',
      content: 'Share a short random thought under 80 words.'
    }], 1.0);

    const ch = await client.channels.fetch(lastChannelId);
    if (ch) await ch.send(`*${reply}*`);

  } catch {}
}

function scheduleThoughts() {
  const delay = (Math.random() * 60 + 30) * 60000;

  setTimeout(async () => {
    await sendSpontaneous();
    scheduleThoughts();
  }, delay);
}

// ═══════════════════════════════════════════════
// DISCORD EVENTS
// ═══════════════════════════════════════════════
client.once('ready', () => {
  console.log(`Online as ${client.user.tag}`);
  scheduleThoughts();
});

client.on('messageCreate', async msg => {
  if (msg.author.bot) return;
  handleMessage(msg);
});

// ═══════════════════════════════════════════════
// EXPRESS
// ═══════════════════════════════════════════════
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});

// ═══════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════
client.login(DISCORD_TOKEN);