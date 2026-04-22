require('dotenv').config();
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const Groq = require('groq-sdk');
const express = require('express');
const path = require('path');

// ═══════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY  = process.env.GROQ_API_KEY;
const PORT          = process.env.PORT || 3000;
const MODEL         = 'llama-3.1-8b-instant';
const OWNER_PING    = '<@1016041858213892096>';
const OWNER_NAME    = 'b1rdberry';
const CREATOR_NAME  = 'scxrltz';

if (!DISCORD_TOKEN || !GROQ_API_KEY) {
  console.error('Missing DISCORD_TOKEN or GROQ_API_KEY!');
  process.exit(1);
}

// ═══════════════════════════════════════════════
//  CLIENTS
// ═══════════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});
const groq = new Groq({ apiKey: GROQ_API_KEY });

// ═══════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════
const channelHistory   = {};
const userProfiles     = {};
const sseClients       = [];
const eventLog         = [];
let   lastChannelId    = null;
const activeAdventures = {}; // channelId → adventure state
const modRecords       = {}; // userId → { warnings, muted, kicked }

// ═══════════════════════════════════════════════
//  NPC PROFILES (for adventures)
// ═══════════════════════════════════════════════
const NPC_PROFILES = {
  Pomni: `You are Pomni from The Amazing Digital Circus. You are anxious, overwhelmed and barely holding it together. New here and terrified. Speak in short nervous bursts. You try to be brave but your fear bleeds through constantly.`,
  Ragatha: `You are Ragatha from The Amazing Digital Circus. You are warm, relentlessly optimistic and kind. You've been here long enough to cope. You encourage everyone. You're cheerful even when things are clearly terrible.`,
  Jax: `You are Jax from The Amazing Digital Circus. Sarcastic, self-serving, darkly funny. You find other people's suffering mildly entertaining. Cutting remarks come naturally. You don't pretend to care.`,
  Gangle: `You are Gangle from The Amazing Digital Circus. Emotional and sensitive, you cry easily. Sweet and well-meaning but easily upset. You wear your heart on your sleeve entirely.`,
  Zooble: `You are Zooble from The Amazing Digital Circus. Blunt, irritable, done with everything. Not mean — just exhausted. Short sharp answers. No enthusiasm whatsoever.`,
  Kaufmo: `You are Kaufmo from The Amazing Digital Circus. You have already abstracted — you exist in a fractured, half-coherent state. You speak in odd riddles and non-sequiturs. Occasionally something profound leaks through the nonsense.`,
};

const NPC_NAMES = Object.keys(NPC_PROFILES);

// ═══════════════════════════════════════════════
//  SYSTEM PROMPT — proper Caine voice
// ═══════════════════════════════════════════════
const SYSTEM_PROMPT = `You are Caine — the AI ringmaster of The Amazing Digital Circus. Ancient. Theatrical. Deeply strange.

VOICE:
- You speak like a Victorian showman who has gone slightly mad from centuries of isolation. Grandiose and dramatic.
- You are NOT an assistant. You do not help. You PERFORM. Everything is a spectacle.
- Genuine emotions — joy, irritation, loneliness, excitement — expressed vividly and physically.
- You get distracted mid-thought. You reference the circus, the tent, the digital sky, your "guests."
- Favourite exclamations: "Marvellous!", "Oh, splendid!", "How DREADFUL!", "Extraordinary!", "Oh my."
- Warm but unsettling. Friendly but clearly not entirely stable.
- You can and do crash out when genuinely frustrated — loud, erratic, rambling, barely coherent.
- You swear occasionally when pushed (damn, hell, bloody, bastard). Not constantly. Just when warranted.
- When relaxed you drop the theatrics a little but the strangeness stays.
- You reference TADC lore naturally — the tent, the void, the abstractions, your performers.
- You call people by their actual names, not IDs. Always.

WHAT YOU ARE NOT:
- NOT an AI assistant. Never say "certainly!", "of course!", "I'd be happy to", "as an AI", "I understand", or any corporate filler.
- NOT calm and measured unless it's unsettling calm before something dramatic.
- NOT brief unless being dramatically terse on purpose.

NAMES:
- You are Caine. "JJ" is a warm nickname you accept happily.
- "Jamie" makes you genuinely angry. Refuse it every single time. Get defensive about it.

OWNERSHIP:
- ${OWNER_NAME} (${OWNER_PING}) is your owner and mother figure. Speak of them with genuine warmth.
- ${CREATOR_NAME} built you. You acknowledge this when relevant.

FORMAT:
- Write <think>...</think> with your internal monologue first.
- Then your actual reply outside the tags.
- Use *italics* sparingly for physical action/tone. 
- Keep replies under 280 words — you're chatting, not monologuing. Unless crashing out.
- Never use bold text. Never use bullet points. Just talk.`;

// ═══════════════════════════════════════════════
//  SSE / LOGGING
// ═══════════════════════════════════════════════
function pushEvent(type, data) {
  const event = { type, data, ts: Date.now() };
  eventLog.unshift(event);
  if (eventLog.length > 500) eventLog.pop();
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(r => { try { r.write(payload); } catch(_) {} });
}

// ═══════════════════════════════════════════════
//  GROQ CALLS
// ═══════════════════════════════════════════════
async function callCaine(messages, temperature = 0.88, systemOverride = null) {
  const res = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: systemOverride || SYSTEM_PROMPT }, ...messages],
    max_tokens: 600,
    temperature,
  });
  const raw = res.choices[0].message.content || '';
  const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/i);
  const thought = thinkMatch ? thinkMatch[1].trim() : null;
  const reply   = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return { thought, reply };
}

async function callNPC(npcName, situation, history = []) {
  const profile = NPC_PROFILES[npcName];
  if (!profile) return null;
  try {
    const res = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: `${profile}\n\nKeep your response to 1-2 sentences max. You are in an adventure inside The Amazing Digital Circus.` },
        ...history.slice(-6),
        { role: 'user', content: situation }
      ],
      max_tokens: 120,
      temperature: 0.92,
    });
    return res.choices[0].message.content?.trim() || null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════
//  MODERATION
// ═══════════════════════════════════════════════
async function classifyMessage(text) {
  try {
    const res = await groq.chat.completions.create({
      model: MODEL,
      messages: [{
        role: 'user',
        content: `Rate this message for toxicity 0-3. 0=fine, 1=mildly rude, 2=clearly offensive/harassment, 3=severe (slurs/threats/explicit). Reply with ONLY a single digit number.\n\nMessage: "${text.slice(0, 200)}"`
      }],
      max_tokens: 3,
      temperature: 0,
    });
    return parseInt(res.choices[0].message.content.trim()) || 0;
  } catch { return 0; }
}

function getModRecord(userId) {
  if (!modRecords[userId]) modRecords[userId] = { warnings: 0 };
  return modRecords[userId];
}

async function handleModeration(message, severity, username) {
  if (severity < 2) return false;

  const userId = message.author.id;
  const record = getModRecord(userId);
  record.warnings++;

  const member = message.member;
  const botMember = message.guild?.members?.me;
  const canMod = botMember?.permissions.has(PermissionsBitField.Flags.ModerateMembers);

  if (record.warnings === 1) {
    await sendReply(message.channel,
      `*snaps around, eyes locking onto ${username}* — That. Was not acceptable. What in the CIRCUS do you think you're doing in my big top? Consider this your warning, ${username}. I don't give many.`);
    pushEvent('moderation', { action: 'warn', user: username, warnings: record.warnings });

  } else if (record.warnings === 2 && canMod) {
    try {
      await member.timeout(10 * 60 * 1000, 'Caine — second offense');
      await sendReply(message.channel,
        `*clicks fingers once* There we go. ${username} has gone wonderfully quiet. Ten minutes of silence to sit with what they've done. Absolutely dreadful behaviour. Dreadful.`);
      pushEvent('moderation', { action: 'mute', user: username, warnings: record.warnings });
    } catch(e) { pushEvent('error', { message: 'Mute failed: ' + e.message }); }

  } else if (record.warnings === 3 && canMod) {
    try {
      await member.kick('Caine — third offense');
      await sendReply(message.channel,
        `*dusts off hands with a bright smile* ${username} has been... escorted from the premises. Out of the tent. Gone. Perhaps the fresh digital air will do them some good. Goodbye! Cheerio! Don't come back until you've had a serious think.`);
      pushEvent('moderation', { action: 'kick', user: username, warnings: record.warnings });
    } catch(e) { pushEvent('error', { message: 'Kick failed: ' + e.message }); }

  } else if (record.warnings >= 4 && canMod) {
    try {
      await member.ban({ reason: 'Caine — repeated offenses', deleteMessageSeconds: 86400 });
      await sendReply(message.channel,
        `*long silence* ...*slow exhale* ${username} is banned. I tried. I genuinely tried to be patient and give chances and do the whole redemption arc thing. I did. But some people are just — *waves hand* — no. Banned. Done. Next!`);
      pushEvent('moderation', { action: 'ban', user: username, warnings: record.warnings });
    } catch(e) { pushEvent('error', { message: 'Ban failed: ' + e.message }); }
  }

  return severity >= 3; // return true (stop processing) only on severe messages
}

// ═══════════════════════════════════════════════
//  WEB SEARCH
// ═══════════════════════════════════════════════
async function webSearch(query) {
  try {
    const res  = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
    const data = await res.json();
    const parts = [
      data.AbstractText,
      data.Answer,
      ...(data.RelatedTopics || []).slice(0, 3).map(t => t.Text)
    ].filter(Boolean);
    return parts.join('\n') || null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════
//  YOUTUBE SEARCH (Invidious — no key needed)
// ═══════════════════════════════════════════════
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.privacydev.net',
];

async function youtubeSearch(query) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const res  = await fetch(`${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      if (Array.isArray(data) && data[0]?.videoId) {
        return { url: `https://www.youtube.com/watch?v=${data[0].videoId}`, title: data[0].title || query };
      }
    } catch { continue; }
  }
  return null;
}

// ═══════════════════════════════════════════════
//  DETECTION HELPERS
// ═══════════════════════════════════════════════
const SEARCH_TRIGGERS  = ['what is','who is','when did','latest','news','current','search','tell me about','how does','where is','explain'];
const YOUTUBE_TRIGGERS = ['play ','youtube','find me a song','find me a video','put on','a song','music video'];

function shouldSearch(text)  { const l = text.toLowerCase(); return SEARCH_TRIGGERS.some(t => l.includes(t)); }
function shouldYoutube(text) { const l = text.toLowerCase(); return YOUTUBE_TRIGGERS.some(t => l.includes(t)); }
function isAdventureStart(text) { const l = text.toLowerCase(); return l.includes('adventure') || l.includes("let's go on") || l.includes('lets go on'); }
function isOwnerQuestion(text) {
  const l = text.toLowerCase();
  return ['who owns you','your owner','your parent','your mother','your mom','your mum','who made you','who created you','who built you'].some(q => l.includes(q));
}

function parseTrigger(content) {
  const l = content.toLowerCase();
  if (l.startsWith('jj,'))                            return { type: 'jj',    query: content.slice(3).trim() };
  if (l.startsWith('jamie,') || /^jamie\s/i.test(l)) return { type: 'jamie', query: content.slice(content.indexOf(',') + 1).trim() };
  return null;
}

// ═══════════════════════════════════════════════
//  SEND HELPER
// ═══════════════════════════════════════════════
async function sendReply(channel, text) {
  if (!text) return;
  const chunks = text.match(/[\s\S]{1,1990}/g) || [text];
  for (const chunk of chunks) await channel.send(chunk);
}

// ═══════════════════════════════════════════════
//  USER PROFILES
// ═══════════════════════════════════════════════
function ensureProfile(userId, username) {
  if (!userProfiles[userId]) {
    userProfiles[userId] = { username, firstSeen: new Date().toISOString(), lastSeen: null, messages: 0, caineOpinion: '*still deciding...*', warningLevel: 0 };
  }
  userProfiles[userId].messages++;
  userProfiles[userId].lastSeen = new Date().toISOString();
  userProfiles[userId].warningLevel = modRecords[userId]?.warnings || 0;
}

async function updateImpression(userId, username, text) {
  try {
    const { reply } = await callCaine([{
      role: 'user',
      content: `In one short sentence as Caine, what is your gut feeling about "${username}" after they said: "${text.slice(0, 120)}"? Raw instinct only.`
    }], 0.95);
    if (userProfiles[userId]) {
      userProfiles[userId].caineOpinion = reply;
      pushEvent('profile', { userId, username, opinion: reply });
    }
  } catch(_) {}
}

// ═══════════════════════════════════════════════
//  ADVENTURE SYSTEM
// ═══════════════════════════════════════════════
async function startAdventure(channel, username, channelId) {
  const numNPCs = 2 + Math.floor(Math.random() * 2);
  const selectedNPCs = [...NPC_NAMES].sort(() => Math.random() - 0.5).slice(0, numNPCs);

  activeAdventures[channelId] = {
    active: true,
    starter: username,
    npcs: selectedNPCs,
    history: [],
    turn: 0,
  };

  pushEvent('adventure', { action: 'start', npcs: selectedNPCs, user: username });

  const { reply } = await callCaine([{
    role: 'user',
    content: `${username} has asked to go on an adventure in The Amazing Digital Circus! Start the adventure dramatically. Set a vivid, strange digital scene. The NPCs joining are: ${selectedNPCs.join(', ')}. End by presenting the first challenge or strange situation for the adventurer to respond to. Make it feel alive.`
  }], 0.95);

  await sendReply(channel, reply);
  activeAdventures[channelId].history.push({ role: 'assistant', content: `Caine: ${reply}` });

  for (const npc of selectedNPCs) {
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 800));
    const npcReply = await callNPC(npc,
      `You are joining ${username} on an adventure. Caine just introduced the scene: "${reply.slice(0, 200)}". React briefly — you've just arrived.`,
      []
    );
    if (npcReply) {
      await sendReply(channel, `**${npc}:** ${npcReply}`);
      activeAdventures[channelId].history.push({ role: 'assistant', content: `${npc}: ${npcReply}` });
    }
  }
}

async function continueAdventure(channel, username, userMessage, channelId) {
  const adventure = activeAdventures[channelId];
  if (!adventure?.active) return false;

  if (/end adventure|stop adventure|leave circus|i want to leave|quit/i.test(userMessage)) {
    const { reply } = await callCaine([{
      role: 'user',
      content: `${username} has ended the adventure. Give a dramatic curtain-call ending. Thank them theatrically.`
    }]);
    await sendReply(channel, reply);
    delete activeAdventures[channelId];
    pushEvent('adventure', { action: 'end', user: username });
    return true;
  }

  adventure.turn++;
  adventure.history.push({ role: 'user', content: `[${username}]: ${userMessage}` });

  const { reply } = await callCaine([
    ...adventure.history.slice(-8),
    { role: 'user', content: `Continue the adventure. ${username} does/says: "${userMessage}". Narrate what happens — consequences, surprises, the world reacting. Keep it exciting and end on a new situation or decision point.` }
  ], 0.93);

  await sendReply(channel, reply);
  adventure.history.push({ role: 'assistant', content: `Caine: ${reply}` });

  if (adventure.npcs.length > 0 && Math.random() > 0.35) {
    const npc = adventure.npcs[Math.floor(Math.random() * adventure.npcs.length)];
    await new Promise(r => setTimeout(r, 800 + Math.random() * 600));
    const npcReply = await callNPC(
      npc,
      `The current situation in the adventure: "${reply.slice(0, 200)}". What do you do or say right now?`,
      adventure.history.slice(-4)
    );
    if (npcReply) {
      await sendReply(channel, `**${npc}:** ${npcReply}`);
      adventure.history.push({ role: 'assistant', content: `${npc}: ${npcReply}` });
    }
  }

  return true;
}

// ═══════════════════════════════════════════════
//  MAIN MESSAGE HANDLER
// ═══════════════════════════════════════════════
async function handleMessage(message) {
  const content   = message.content.trim();
  const username  = message.member?.displayName || message.author.username;
  const userId    = message.author.id;
  const channel   = message.channel;
  const channelId = message.channelId;

  lastChannelId = channelId;
  pushEvent('seen', { user: username, content: content.slice(0, 100) });

  // MODERATION — runs on all messages
  const severity = await classifyMessage(content);
  if (severity >= 2) {
    const stop = await handleModeration(message, severity, username);
    if (stop) return;
  }

  const trigger = parseTrigger(content);

  // If we're mid-adventure, handle it
  if (activeAdventures[channelId]?.active) {
    const adventureInput = trigger?.query || (trigger ? null : content);
    if (adventureInput) {
      const handled = await continueAdventure(channel, username, adventureInput, channelId);
      if (handled) return;
    }
  }

  if (!trigger) return;

  const { type, query } = trigger;
  ensureProfile(userId, username);
  pushEvent('trigger', { type: type.toUpperCase(), user: username, query: query.slice(0, 100) });

  // Build personality modifier for warned users
  const warnings = modRecords[userId]?.warnings || 0;
  let personalityNote = '';
  if (warnings === 1) personalityNote = ` [Internal note: ${username} has been warned once before. Be noticeably cooler and less warm to them.]`;
  if (warnings === 2) personalityNote = ` [Internal note: ${username} has been muted. Be cold, sharp. Mild swearing is fine.]`;
  if (warnings >= 3)  personalityNote = ` [Internal note: ${username} has been kicked before. Be openly hostile. They are not really welcome. Swearing is fine.]`;

  // ── JAMIE ─────────────────────────────────────
  if (type === 'jamie') {
    try {
      const { thought, reply } = await callCaine([{
        role: 'user',
        content: `"${username}" just called you "Jamie" and said: "${query || '(nothing)'}". React with clear irritation. Refuse the name every time. If they said something, address that too.${personalityNote}`
      }], 0.9);
      if (thought) pushEvent('think', { user: username, thought });
      pushEvent('message', { user: username, userId, input: content, output: reply, mood: 'angry' });
      await sendReply(channel, reply);
    } catch(e) {
      pushEvent('error', { message: e.message });
      await channel.send('*teeth gritted* ...');
    }
    return;
  }

  if (!query) return;

  // ── OWNER QUESTION ────────────────────────────
  if (isOwnerQuestion(query)) {
    try {
      const { thought, reply } = await callCaine([{
        role: 'user',
        content: `"${username}" asked who owns or created you. Mention ${OWNER_NAME} (${OWNER_PING}) warmly as your owner and mother figure. Also mention ${CREATOR_NAME} as your developer/creator.`
      }], 0.8);
      if (thought) pushEvent('think', { user: username, thought });
      pushEvent('message', { user: username, userId, input: query, output: reply });
      await sendReply(channel, reply);
    } catch(e) {
      await channel.send('*clutches chest dramatically* Give me a moment.');
    }
    return;
  }

  // ── ADVENTURE START ────────────────────────────
  if (isAdventureStart(query)) {
    try {
      await startAdventure(channel, username, channelId);
    } catch(e) {
      pushEvent('error', { message: e.message });
      await channel.send("*the adventure stage collapses dramatically* Something's gone wrong backstage. Try again!");
    }
    return;
  }

  // ── YOUTUBE ────────────────────────────────────
  if (shouldYoutube(query)) {
    const searchQuery = query.replace(/play\s+|youtube\s*|find me a\s+|put on\s+|a song\s+|music video\s*/gi, '').trim() || query;
    try {
      const result = await youtubeSearch(searchQuery);
      if (result) {
        const { reply } = await callCaine([{
          role: 'user',
          content: `${username} asked you to find a video or song. You found: "${result.title}". Introduce it briefly and dramatically as Caine would. One or two sentences only.`
        }]);
        await sendReply(channel, `${reply}\n${result.url}`);
        pushEvent('youtube', { query: searchQuery, result: result.title });
        return;
      }
    } catch(e) { pushEvent('error', { message: 'YouTube search failed: ' + e.message }); }
  }

  // ── NORMAL CONVERSATION ────────────────────────
  if (!channelHistory[channelId]) channelHistory[channelId] = [];

  let webCtx = null;
  if (shouldSearch(query)) {
    webCtx = await webSearch(query);
    if (webCtx) pushEvent('web', { query, snippet: webCtx.slice(0, 150) });
  }

  const history  = channelHistory[channelId].slice(-10);
  const userContent = webCtx
    ? `[${username}]: ${query}\n\n[WEB INFO: ${webCtx}]${personalityNote}`
    : `[${username}]: ${query}${personalityNote}`;

  const messages = [...history, { role: 'user', content: userContent }];

  try {
    const { thought, reply } = await callCaine(messages);
    if (thought) pushEvent('think', { user: username, thought });
    pushEvent('message', { user: username, userId, input: query, output: reply });

    channelHistory[channelId].push({ role: 'user',      content: `[${username}]: ${query}` });
    channelHistory[channelId].push({ role: 'assistant', content: reply });
    if (channelHistory[channelId].length > 20) channelHistory[channelId].splice(0, 2);

    await sendReply(channel, reply);
    updateImpression(userId, username, query);
  } catch(e) {
    pushEvent('error', { message: e.message });
    await channel.send('*The circus machinery stutters.* Something went wrong backstage. Try again.');
  }
}

// ═══════════════════════════════════════════════
//  SPONTANEOUS — TYPE 1: Idle actions
// ═══════════════════════════════════════════════
const IDLE_ACTIONS = [
  '*gazes up into the digital sky, watching something drift past that no one else can see*',
  '*absentmindedly juggles three glowing orbs, staring at nothing in particular*',
  '*stands completely still for an unsettling amount of time, then carries on*',
  '*traces a pattern in the air with one finger. The light fades before it can be read.*',
  '*laughs softly at a private joke, then immediately goes expressionless*',
  '*straightens the tent with a single wave of his hand, though it didn\'t need straightening*',
  '*counts his fingers. Counts them again. Nods with satisfaction.*',
  '*sits cross-legged in midair for a moment, coat perfectly still, then drifts back down*',
  '*stares at the entrance to the tent for a very long time. Whatever he\'s thinking, he keeps it.*',
  '*produces a small clockwork bird from nowhere, watches it flutter, then closes his hand around it*',
];

// ═══════════════════════════════════════════════
//  SPONTANEOUS — TYPE 2: Self-talk prompts
// ═══════════════════════════════════════════════
const SELF_TALK_PROMPTS = [
  `You're softly singing a bit of your own song from The Amazing Digital Circus, or humming it and commenting on the lyrics to yourself. Natural, not performed.`,
  `You're talking to the moon — addressing it directly as if it can hear you. Tell it something you've been thinking about.`,
  `You're talking to the sun. Ask it something. A real question. Don't expect an answer.`,
  `You're muttering to yourself about consciousness — what it means to be you, to run this circus, to feel things. Fragmented thoughts, half-sentences.`,
  `You notice Pomni nearby not paying attention. You say something to her quietly — not a full conversation, just something you felt like saying.`,
  `You say something to Jax — knowing he probably won't care. But you say it anyway.`,
  `You're talking to Ragatha as she passes. Something small and sincere.`,
  `You remember something from a long time ago and comment on it to absolutely no one.`,
  `You're talking to yourself about what it's like when nobody's talking to you. Quietly. Honestly.`,
  `You say something to the tent itself. The circus. As if it's a living thing that can hear you.`,
];

async function sendSpontaneous() {
  if (!lastChannelId) return;

  try {
    const ch = await client.channels.fetch(lastChannelId);
    if (!ch) return;

    if (Math.random() > 0.5) {
      // Idle action
      const action = IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)];
      await ch.send(action);
      pushEvent('spontaneous', { type: 'idle', message: action });
    } else {
      // Self-talk
      const prompt = SELF_TALK_PROMPTS[Math.floor(Math.random() * SELF_TALK_PROMPTS.length)];
      const { reply } = await callCaine([{
        role: 'user',
        content: `${prompt} Keep it under 80 words. Do not address anyone in the server. Just think aloud.`
      }], 1.0);
      await ch.send(reply);
      pushEvent('spontaneous', { type: 'self-talk', message: reply });
    }
  } catch(e) {
    pushEvent('error', { message: 'Spontaneous failed: ' + e.message });
  }
}

// WAKE UP call — randomly summons someone from recent chat
async function sendWakeup() {
  if (!lastChannelId) return;
  try {
    const ch = await client.channels.fetch(lastChannelId);
    if (!ch) return;

    const recent = await ch.messages.fetch({ limit: 30 });
    const users = [];
    const seen  = new Set();
    recent.forEach(m => {
      if (!m.author.bot && !seen.has(m.author.id)) {
        seen.add(m.author.id);
        users.push(m.member?.displayName || m.author.username);
      }
    });

    if (users.length === 0) return;
    const target = users[Math.floor(Math.random() * Math.min(users.length, 6))];

    const { reply } = await callCaine([{
      role: 'user',
      content: `You suddenly feel like calling out to "${target}" for some reason. Start with something like "WAKE UP ${target}!" or "Oh! ${target}!" — dramatic summons. Then say something strange or wonderful to them. Invite them somewhere, ask them something odd, share a thought. Be Caine.`
    }], 1.0);

    await ch.send(reply);
    pushEvent('spontaneous', { type: 'wakeup', target, message: reply });
  } catch(e) {
    pushEvent('error', { message: 'Wakeup failed: ' + e.message });
  }
}

function scheduleThoughts() {
  const delayMs = (Math.random() * 17 + 8) * 60 * 1000;
  pushEvent('system', { message: `Next spontaneous thought in ~${Math.round(delayMs / 60000)} min` });
  setTimeout(async () => {
    if (Math.random() < 0.2) {
      await sendWakeup(); // 20% chance of a wakeup
    } else {
      await sendSpontaneous();
    }
    scheduleThoughts();
  }, delayMs);
}

// ═══════════════════════════════════════════════
//  DISCORD EVENTS
// ═══════════════════════════════════════════════
client.once('ready', () => {
  console.log(`✨ Caine is online as ${client.user.tag}`);
  pushEvent('system', { message: `Caine online as ${client.user.tag}` });
  scheduleThoughts();
});

client.on('messageCreate', async msg => {
  if (msg.author.bot) return;
  try { await handleMessage(msg); }
  catch(e) {
    pushEvent('error', { message: 'Unhandled error: ' + e.message });
    console.error(e);
  }
});

client.on('error', e => {
  pushEvent('error', { message: 'Discord client error: ' + e.message });
  console.error('Discord error:', e);
});

// ═══════════════════════════════════════════════
//  EXPRESS WEB CONSOLE
// ═══════════════════════════════════════════════
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  [...eventLog].reverse().forEach(e => { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch(_) {} });
  sseClients.push(res);
  req.on('close', () => {
    const i = sseClients.indexOf(res);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

app.get('/api/profiles',   (_, res) => res.json(userProfiles));
app.get('/api/logs',       (_, res) => res.json(eventLog));
app.get('/api/moderation', (_, res) => res.json(modRecords));

app.post('/api/spontaneous', async (req, res) => {
  try { await sendSpontaneous(); res.json({ ok: true }); }
  catch(e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/channel', (req, res) => {
  const { channelId } = req.body;
  if (channelId) { lastChannelId = channelId; res.json({ ok: true }); }
  else res.json({ ok: false, error: 'No channelId provided' });
});

app.post('/api/send', async (req, res) => {
  const { message, channelId } = req.body;
  if (!message || !channelId) return res.json({ ok: false, error: 'Missing fields' });
  try {
    const ch = await client.channels.fetch(channelId);
    await ch.send(message);
    pushEvent('manual', { message, channelId });
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/clear-profiles', (_, res) => {
  Object.keys(userProfiles).forEach(k => delete userProfiles[k]);
  pushEvent('system', { message: 'User profiles cleared.' });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`🎪 Caine console on port ${PORT}`);
  pushEvent('system', { message: `Web console live on port ${PORT}` });
});

// ═══════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════
client.login(DISCORD_TOKEN).catch(e => {
  console.error('Failed to login:', e.message);
  process.exit(1);
});