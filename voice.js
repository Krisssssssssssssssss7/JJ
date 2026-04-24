/**
 * voice.js — JJ's ears and mouth
 *
 * Requires:
 *   npm install @discordjs/voice @discordjs/opus prism-media edge-tts node-fetch@2 fluent-ffmpeg
 *   ffmpeg must be installed on the system (apt install ffmpeg / brew install ffmpeg)
 *
 * Flow:
 *   Someone talks in VC
 *     → opus audio buffered per user
 *       → silence detected → decode to WAV
 *         → Groq Whisper transcribes
 *           → JJ decides whether to respond (or just listens)
 *             → if yes: Groq LLM generates reply
 *               → edge-tts speaks it into VC
 */

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  getVoiceConnection,
  EndBehaviorType,
} = require('@discordjs/voice');

const prism   = require('prism-media');
const EdgeTTS = require('edge-tts');
const fs      = require('fs');
const path    = require('path');
const { Writable, PassThrough } = require('stream');

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────

// ElevenLabs upgrade: swap TTS_MODE to 'elevenlabs' and set ELEVENLABS_API_KEY
const TTS_MODE          = process.env.TTS_MODE || 'edge'; // 'edge' | 'elevenlabs'
const ELEVENLABS_KEY    = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE  = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Adam

// Edge TTS voice — pick something that fits JJ's vibe
// Full list: npx edge-tts --list-voices
const EDGE_VOICE = 'en-GB-RyanNeural'; // British male, slightly moody. Good fit.

// How long (ms) of silence before we process what someone said
const SILENCE_THRESHOLD_MS = 1200;

// Max audio we'll buffer per utterance (ms) — prevents runaway buffering
const MAX_UTTERANCE_MS = 15000;

// How often JJ might spontaneously say something in VC (ms)
const VC_SPONTANEOUS_INTERVAL = 8 * 60 * 1000; // every 8 min

// Chance JJ chimes in on something said (0-1) — increases if they're mentioned
const BASE_CHIME_CHANCE = 0.25;

// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────

// guildId -> { connection, player, currentChannelId, listening, speakingUsers }
const vcState = {};

// Temp dir for audio files
const TMP_DIR = path.join(__dirname, '.jj_audio_tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

function getTmpPath(name) {
  return path.join(TMP_DIR, name);
}

function cleanTmp(filePath) {
  try { fs.unlinkSync(filePath); } catch(_) {}
}

// ─────────────────────────────────────────────
//  TTS — text → audio file path
// ─────────────────────────────────────────────

async function textToSpeech(text) {
  const outPath = getTmpPath(`jj_tts_${Date.now()}.mp3`);

  if (TTS_MODE === 'elevenlabs' && ELEVENLABS_KEY) {
    return await ttsElevenLabs(text, outPath);
  }
  return await ttsEdge(text, outPath);
}

async function ttsEdge(text, outPath) {
  return new Promise((resolve, reject) => {
    const tts = new EdgeTTS({ voice: EDGE_VOICE, lang: 'en-GB' });
    tts.synthesize(text, outPath, (err) => {
      if (err) reject(err);
      else resolve(outPath);
    });
  });
}

async function ttsElevenLabs(text, outPath) {
  const fetch = require('node-fetch');
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: { stability: 0.4, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs error: ${res.status}`);
  const buffer = await res.buffer();
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

// ─────────────────────────────────────────────
//  STT — audio buffer → transcript via Groq Whisper
// ─────────────────────────────────────────────

async function transcribeAudio(groq, pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length < 8000) return null; // too short, skip

  const wavPath = getTmpPath(`jj_stt_${Date.now()}.wav`);
  try {
    // Write raw PCM as WAV (48kHz, 16-bit, 2ch — Discord's format)
    pcmToWav(pcmBuffer, wavPath, 48000, 2);

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: 'whisper-large-v3',
      language: 'en',
      response_format: 'text',
    });

    return (transcription || '').trim() || null;
  } catch(e) {
    console.error('[STT] Transcription failed:', e.message);
    return null;
  } finally {
    cleanTmp(wavPath);
  }
}

// Write raw PCM to a proper WAV file with header
function pcmToWav(pcmBuffer, outPath, sampleRate, channels) {
  const bitsPerSample = 16;
  const byteRate      = sampleRate * channels * bitsPerSample / 8;
  const blockAlign    = channels * bitsPerSample / 8;
  const dataSize      = pcmBuffer.length;
  const headerSize    = 44;
  const header        = Buffer.alloc(headerSize);

  header.write('RIFF', 0);
  header.writeUInt32LE(headerSize + dataSize - 8, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);           // PCM chunk size
  header.writeUInt16LE(1, 20);            // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(outPath, Buffer.concat([header, pcmBuffer]));
}

// ─────────────────────────────────────────────
//  PLAY AUDIO — TTS → VC
// ─────────────────────────────────────────────

async function playInVC(guildId, audioPath) {
  const state = vcState[guildId];
  if (!state || !state.player) return;

  return new Promise((resolve, reject) => {
    try {
      const resource = createAudioResource(audioPath);
      state.player.play(resource);
      state.isSpeaking = true;

      state.player.once(AudioPlayerStatus.Idle, () => {
        state.isSpeaking = false;
        cleanTmp(audioPath);
        resolve();
      });

      state.player.once('error', (err) => {
        state.isSpeaking = false;
        cleanTmp(audioPath);
        reject(err);
      });
    } catch(e) {
      reject(e);
    }
  });
}

// ─────────────────────────────────────────────
//  JJ SPEAKS IN VC
// ─────────────────────────────────────────────

async function jjSpeakInVC(guildId, text, groq, pushEvent) {
  if (!text || !text.trim()) return;

  const state = vcState[guildId];
  if (!state) return;

  // Don't interrupt ourselves
  if (state.isSpeaking) return;

  pushEvent('vc_speak', { text: text.slice(0, 100) });

  try {
    const audioPath = await textToSpeech(text);
    await playInVC(guildId, audioPath);
  } catch(e) {
    pushEvent('error', { message: 'TTS failed: ' + e.message });
    console.error('[TTS]', e);
  }
}

// ─────────────────────────────────────────────
//  DECISION ENGINE — should JJ respond to this?
// ─────────────────────────────────────────────

async function shouldJJRespond(transcript, speakerName, groq, jjState, botName = 'JJ') {
  if (!transcript) return { respond: false };

  const lower = transcript.toLowerCase();

  // Always respond if directly addressed
  const directlyAddressed = lower.includes('jj') || lower.includes(botName.toLowerCase());
  if (directlyAddressed) return { respond: true, reason: 'directly addressed' };

  // Higher chance if JJ is in a good mood
  const moodBoost = (jjState.mood || 0) * 0.05;
  const chanceToJoin = BASE_CHIME_CHANCE + moodBoost;

  if (Math.random() > chanceToJoin) return { respond: false };

  // Ask the LLM whether JJ genuinely wants to chime in
  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'system',
        content: `You are JJ's impulse filter. Answer only YES or NO.`
      }, {
        role: 'user',
        content: `Someone in voice chat (${speakerName}) just said: "${transcript.slice(0, 200)}"
Does JJ genuinely want to chime in on this — not because they should, but because something about it catches them? JJ talks when they have something real to add, not to fill silence. YES or NO.`
      }],
      max_tokens: 5,
      temperature: 0.7,
    });

    const answer = (res.choices[0].message.content || '').trim().toUpperCase();
    return { respond: answer.startsWith('YES'), reason: 'LLM decided' };
  } catch(_) {
    return { respond: false };
  }
}

// ─────────────────────────────────────────────
//  LISTEN — set up per-user audio capture
// ─────────────────────────────────────────────

function listenToUser(connection, userId, username, guildId, groq, callJJ, jjState, pushEvent) {
  const receiver = connection.receiver;

  // Subscribe to this user's audio stream
  const audioStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: SILENCE_THRESHOLD_MS,
    },
  });

  // Decode opus → stereo PCM (48kHz, 16-bit, 2ch)
  const decoder = new prism.opus.Decoder({
    frameSize: 960,
    channels: 2,
    rate: 48000,
  });

  const pcmChunks = [];
  let totalBytes  = 0;
  const maxBytes  = (48000 * 2 * 2 * MAX_UTTERANCE_MS) / 1000; // PCM bytes

  audioStream.pipe(decoder);

  decoder.on('data', (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes < maxBytes) pcmChunks.push(chunk);
  });

  // When stream ends (silence detected), process the utterance
  decoder.on('end', async () => {
    if (pcmChunks.length === 0) return;

    const pcmBuffer = Buffer.concat(pcmChunks);
    pcmChunks.length = 0;
    totalBytes = 0;

    const state = vcState[guildId];
    if (!state || state.isSpeaking) return; // don't process if JJ is talking

    pushEvent('vc_heard', { user: username, bytes: pcmBuffer.length });

    // Transcribe
    const transcript = await transcribeAudio(groq, pcmBuffer);
    if (!transcript) return;

    pushEvent('vc_transcript', { user: username, text: transcript });

    // Decide whether to respond
    const { respond, reason } = await shouldJJRespond(transcript, username, groq, jjState);
    if (!respond) return;

    pushEvent('vc_responding', { user: username, transcript, reason });

    // Generate JJ's voice response
    try {
      const { reply } = await callJJ([{
        role: 'user',
        content: `[VOICE CHAT] ${username} just said: "${transcript}"\nYou're in voice. Keep it SHORT — 1-3 sentences max. Natural spoken rhythm. No asterisks, no formatting. Just talk.`
      }], 0.9, false);

      if (reply) {
        await jjSpeakInVC(guildId, reply, groq, pushEvent);
      }
    } catch(e) {
      pushEvent('error', { message: 'VC response generation failed: ' + e.message });
    }
  });

  decoder.on('error', (e) => {
    pushEvent('error', { message: `Audio decode error for ${username}: ${e.message}` });
  });
}

// ─────────────────────────────────────────────
//  JOIN VC
// ─────────────────────────────────────────────

async function joinVC(channel, groq, callJJ, jjState, pushEvent) {
  const guildId   = channel.guild.id;
  const channelId = channel.id;

  // Already in this channel
  if (vcState[guildId]?.currentChannelId === channelId) return { ok: true, already: true };

  // Leave existing connection if any
  await leaveVC(guildId, pushEvent);

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf:       false, // we need to hear people
    selfMute:       false,
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  vcState[guildId] = {
    connection,
    player,
    currentChannelId: channelId,
    isSpeaking: false,
    listeningTo: new Set(),
    spontaneousTimer: null,
  };

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    pushEvent('vc_joined', { channelId, guildId });
  } catch(e) {
    pushEvent('error', { message: 'Failed to connect to VC: ' + e.message });
    return { ok: false, error: e.message };
  }

  // Set up speaking listener — catches when users START talking
  connection.receiver.speaking.on('start', (userId) => {
    const state = vcState[guildId];
    if (!state || state.listeningTo.has(userId)) return;
    state.listeningTo.add(userId);

    // Try to resolve username from guild
    const member = channel.guild.members.cache.get(userId);
    const username = member?.user?.username || `User-${userId.slice(-4)}`;

    listenToUser(connection, userId, username, guildId, groq, callJJ, jjState, pushEvent);

    // Clean up the listener set after stream ends
    connection.receiver.speaking.once('end', (endUserId) => {
      if (endUserId === userId) {
        setTimeout(() => state.listeningTo.delete(userId), SILENCE_THRESHOLD_MS + 500);
      }
    });
  });

  // Disconnect handler
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // Reconnecting
    } catch {
      cleanupVC(guildId);
      pushEvent('vc_disconnected', { guildId });
    }
  });

  // Spontaneous VC chatter — JJ talks when the mood strikes
  startVCSpontaneous(guildId, groq, callJJ, jjState, pushEvent);

  return { ok: true };
}

// ─────────────────────────────────────────────
//  LEAVE VC
// ─────────────────────────────────────────────

async function leaveVC(guildId, pushEvent) {
  const state = vcState[guildId];
  if (!state) return;

  clearInterval(state.spontaneousTimer);

  try {
    state.connection.destroy();
  } catch(_) {}

  cleanupVC(guildId);
  pushEvent('vc_left', { guildId });
}

function cleanupVC(guildId) {
  delete vcState[guildId];
}

// ─────────────────────────────────────────────
//  SPONTANEOUS VC TALK — JJ speaks up unprompted
// ─────────────────────────────────────────────

// Things JJ genuinely cares about and might just... start talking about
const JJ_INTERESTS = [
  "cheese — specifically which ones are being slept on and why",
  "why certain songs hit different late at night",
  "emo music and why people dismiss it without actually listening",
  "something that's been bothering them about people online lately",
  "the specific vibe of rain — why it's different from other weather",
  "something about this server or these people they've been thinking about",
  "a random opinion about food they feel strongly about",
  "why Michael Jackson's vocal technique is objectively underrated (only if they're in a talkative mood)",
  "being tired in a way that isn't about sleep",
  "how some things feel smaller than they used to and some feel bigger",
  "a genuine question they want to ask whoever is in VC",
  "something funny they thought of but didn't say earlier",
  "why they actually like being in voice sometimes even though they won't admit it",
];

function startVCSpontaneous(guildId, groq, callJJ, jjState, pushEvent) {
  const state = vcState[guildId];
  if (!state) return;

  state.spontaneousTimer = setInterval(async () => {
    const currentState = vcState[guildId];
    if (!currentState || currentState.isSpeaking) return;

    // Only talk if people are actually in VC
    const connection  = currentState.connection;
    const channelId   = currentState.currentChannelId;

    // Check if JJ is in the mood
    const moodScore   = jjState.mood || 0;
    const talkChance  = 0.4 + moodScore * 0.1; // higher mood = more talkative
    if (Math.random() > talkChance) return;

    const topic = JJ_INTERESTS[Math.floor(Math.random() * JJ_INTERESTS.length)];
    const obsession = jjState.currentObsession || null;

    pushEvent('vc_spontaneous_attempt', { topic });

    try {
      const { reply } = await callJJ([{
        role: 'user',
        content: `You're in a voice channel. It's quiet for a moment. You feel like saying something — not because anyone asked, but because this thing is just in your head right now.
Topic on your mind: "${obsession || topic}"
Keep it SHORT — 1-3 sentences. Talk like you're actually in a voice call with people, not typing. Natural rhythm. No asterisks. No formatting. Just say it.`
      }], 1.0, false);

      if (reply && reply.length > 5) {
        await jjSpeakInVC(guildId, reply, groq, pushEvent);
        pushEvent('vc_spontaneous', { text: reply.slice(0, 100) });
      }
    } catch(e) {
      pushEvent('error', { message: 'VC spontaneous failed: ' + e.message });
    }
  }, VC_SPONTANEOUS_INTERVAL);
}

// ─────────────────────────────────────────────
//  STATUS / HELPERS
// ─────────────────────────────────────────────

function isInVC(guildId) {
  return !!vcState[guildId];
}

function getVCStatus(guildId) {
  const state = vcState[guildId];
  if (!state) return null;
  return {
    channelId:   state.currentChannelId,
    isSpeaking:  state.isSpeaking,
    listeningTo: state.listeningTo.size,
  };
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  joinVC,
  leaveVC,
  jjSpeakInVC,
  isInVC,
  getVCStatus,
};
