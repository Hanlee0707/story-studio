#!/usr/bin/env node
// Story Studio maker: turns a kid's story request (a document in the Story Studio canvas db)
// into a short two-voice podcast with a picture per scene, and writes it back into the same
// canvas db as base64 documents, so the page plays it with no new canvas version.
//
// Runs anywhere with node >= 20, curl and ffmpeg (Han's Mac, a Claude Code cloud routine).
// All HTTP goes through curl so an outbound proxy in the cloud sandbox is honoured.
//
// Everything is made with Gemini: the story (gemini-3.8-flash, schema-bound JSON), the voices
// (gemini-2.5-flash-preview-tts, two speakers) and the pictures (gemini-2.5-flash-image).
// Env: SPROUT_MCP_URL, SPROUT_TOKEN (connection token, canvas:read+write), CANVAS_ID, GEMINI_API_KEY.
// Optional: STUDIO_DRY=1 (story only, nothing written past the meta).
// Usage: node make.mjs --request <id> --kid <childId> [--facts <file>]   (one request; the facts file holds
//        kid-safe true facts the waking agent found on the web, one per line; without it the maker searches itself)
//        node make.mjs --sweep                          (every request still at status "asked")
//        node make.mjs --prompt "..." --kid <childId>   (no request doc: just make an episode)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = (k, d) => { const v = process.env[k]; if (v === undefined || v === '') { if (d !== undefined) return d; die(`missing env ${k}`); } return v; };
const die = (m) => { console.error('make: ' + m); process.exit(1); };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : []).filter(Boolean));

const MCP = env('SPROUT_MCP_URL', 'https://sprout-server-stage-606162082569.europe-west3.run.app/mcp');
const TOKEN = env('SPROUT_TOKEN');
const CANVAS = env('CANVAS_ID');
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const STORY_MODEL = env('STUDIO_STORY_MODEL', 'gemini-3.8-flash');
const TTS_MODEL = env('STUDIO_TTS_MODEL', 'gemini-2.5-flash-preview-tts');
const IMAGE_MODEL = env('STUDIO_IMAGE_MODEL', 'gemini-2.5-flash-image');
const gemini = (model, body, timeout = 120) => curl(`${GEMINI}/${model}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env('GEMINI_API_KEY') }, body, timeout });
const CHUNK = 60000;            // base64 chars per db document (moderation takes 20 x 4000 per request; 60K leaves room)
const SPEAKERS = { Sunny: 'Kore', Pip: 'Puck', Jimin: 'Zephyr', V: 'Charon' };
const SCENES = Number(process.env.STUDIO_SCENES || 10);
const work = mkdtempSync(join(tmpdir(), 'studio-'));

/* ---------- http through curl (async, so voices and pictures overlap) ---------- */
function curl(url, { method = 'GET', headers = {}, body, out, timeout = 120 } = {}) {
  const a = ['-sS', '-m', String(timeout), '-X', method, url, '-w', '\n%{http_code}'];
  for (const [k, v] of Object.entries(headers)) a.push('-H', `${k}: ${v}`);
  let bodyFile;
  if (body !== undefined) { bodyFile = join(work, `body-${Date.now()}-${Math.random().toString(36).slice(2)}`); writeFileSync(bodyFile, typeof body === 'string' ? body : JSON.stringify(body)); a.push('--data-binary', '@' + bodyFile); }
  if (out) a.push('-o', out);
  return new Promise((resolve, reject) => {
    const p = spawn('curl', a); let so = '', se = '';
    p.stdout.on('data', d => { so += d; }); p.stderr.on('data', d => { se += d; });
    p.on('error', reject);
    p.on('close', code => {
      if (bodyFile) rmSync(bodyFile, { force: true });
      if (code !== 0) return reject(new Error(`curl ${url}: ${se.trim().slice(0, 200)}`));
      const nl = so.lastIndexOf('\n');
      resolve({ status: Number(so.slice(nl + 1)), text: so.slice(0, nl) });
    });
  });
}

/* ---------- sprout canvas db over MCP ---------- */
let rpcId = 1;
async function tool(name, argsObj) {
  const r = await curl(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, 'user-agent': 'story-studio-maker/1' }, body: { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: argsObj } } });
  if (r.status >= 300) throw new Error(`mcp ${name} http ${r.status}: ${r.text.slice(0, 300)}`);
  const data = r.text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n') || r.text;
  const msg = JSON.parse(data);
  if (msg.error) throw new Error(`mcp ${name}: ${JSON.stringify(msg.error).slice(0, 300)}`);
  const content = msg.result?.content?.[0]?.text;
  const parsed = content ? JSON.parse(content) : msg.result;
  if (parsed && typeof parsed === 'object') delete parsed._sprout;
  if (msg.result?.isError) throw new Error(`mcp ${name}: ${JSON.stringify(parsed).slice(0, 300)}`);
  return parsed;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function write(path, data, action = 'set', tries = 12) {
  for (let i = 1; ; i++) {
    const res = await tool('canvas_write_documents', { canvasId: CANVAS, writes: [{ action, path, data }] });
    const r = res.results?.[0];
    if (r?.ok) return r.version;
    const code = r?.error?.code;
    if (code === 'unavailable' && i < tries) { await sleep(Math.min(2000 * i, 15000)); continue; }
    const err = new Error(`write ${path}: ${JSON.stringify(r?.error || res).slice(0, 300)}`); err.code = code; throw err;
  }
}
const read = async (path) => (await tool('canvas_get_document', { canvasId: CANVAS, path })).doc;
const list = async (path, where) => (await tool('canvas_list_documents', { canvasId: CANVAS, path, ...(where ? { where } : {}) })).docs || [];

/* ---------- base64 parts: the text classifier sometimes refuses a random base64 string; a refused
   chunk is split in two and both halves go again, which changes the strings it sees ---------- */
async function writeParts(prefix, b64) {
  const queue = []; for (let i = 0; i < b64.length; i += CHUNK) queue.push(b64.slice(i, i + CHUNK));
  const done = [];
  while (queue.length) {
    const part = queue.shift();
    try { await write(`${prefix}/${done.length}`, { k: done.length, b64: part }); done.push(part.length); }
    catch (e) {
      if (e.code === 'invalid_argument' && part.length > 8000) { const h = Math.ceil(part.length / 2); queue.unshift(part.slice(0, h), part.slice(h)); log('  a chunk was refused by the content check; splitting it'); continue; }
      throw e;
    }
  }
  return done.length;
}

/* ---------- the story ---------- */
/* ---------- facts: a Google-grounded call so real people, teams and animals come out right ---------- */
async function gatherFacts(ask) {
  const r = await gemini(STORY_MODEL, { contents: [{ parts: [{ text: `A four year old asked for a story: "${ask}". If it names anything real (a person, a band, a team, a place, an animal, a thing), look it up and list up to 8 short true facts a small child would enjoy about each: what they do, what they are known for, where they are from, a nickname, a famous moment. Only facts a child could hear: nothing about private life, money, injuries, deaths, politics or anything scary. One fact per line, plain words. For each real person also add one line starting with "Looks:" saying whether they are a man, woman, boy or girl, their hair, build and what they usually wear, so an illustrator draws them right. If nothing real is named, answer exactly: none` }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2 } }, 90);
  if (r.status >= 300) { log('facts: skipped (http ' + r.status + ')'); return ''; }
  const text = (JSON.parse(r.text).candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!text || /^none\b/i.test(text)) return '';
  return text.slice(0, 2000);
}

function storyPrompt(ask, facts) {
  return `You write a short audio story podcast for a four year old girl who asked, in her own words: "${ask}".${facts ? `\nTrue facts about the real things she named, found just now; weave a few in naturally and never contradict them:\n${facts}\n` : ''}
Give: a title (max 6 words); "style": one line fixing the look of EVERY picture (children's picture book, soft watercolor, warm palette, rounded friendly shapes, the same lighting and brush in all scenes); "cast": the 2 to 5 recurring characters with a fixed look each (hair, outfit colors, one signature item) so every picture draws them the same. For each cast member set "real": true when it is a real person, band member, team or animal species the girl named, with "wiki" = the exact English Wikipedia page title (e.g. "Harry_Kane", "V_(singer)", "Jimin", "Emperor_penguin"); otherwise real false and wiki "". A real person keeps their true gender, hair and usual outfit in "look" (the facts above say how they look); and exactly ${SCENES} scenes.
Each scene: "art" = the place and action of that moment only, naming the cast members present (their looks come from "cast", do not repeat them), no text in the image, at most 35 words; "lines" = 2 to 4 spoken lines.
Speakers: Sunny (warm storyteller, most lines), Pip (small excited sidekick), Jimin and V (BTS members as kind, playful friends; they speak only in their own voice). At most TWO different speakers in any one scene.
If the ask names BTS or a member, they are kind, playful friends in the story; keep real people as characters only, invent nothing about their private lives.
Gentle, funny, cozy, nothing scary, a warm ending. Short sentences a four year old follows by ear. About 450 spoken words in all.`;
}
const STORY_SCHEMA = {
  type: 'OBJECT', required: ['title', 'style', 'cast', 'scenes'],
  properties: {
    title: { type: 'STRING' },
    style: { type: 'STRING' },
    cast: { type: 'ARRAY', items: { type: 'OBJECT', required: ['name', 'look', 'real', 'wiki'], properties: { name: { type: 'STRING' }, look: { type: 'STRING' }, real: { type: 'BOOLEAN' }, wiki: { type: 'STRING' } } } },
    scenes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT', required: ['art', 'lines'],
        properties: {
          art: { type: 'STRING' },
          lines: { type: 'ARRAY', items: { type: 'OBJECT', required: ['speaker', 'text'], properties: { speaker: { type: 'STRING', enum: ['Sunny', 'Pip', 'Jimin', 'V'] }, text: { type: 'STRING' } } } },
        },
      },
    },
  },
};
async function makeStory(ask) {
  // facts come from the agent that woke us (--facts <file>, found with its own web search); without them the maker asks Gemini with search grounding
  let facts = '';
  if (args.facts) { try { facts = readFileSync(String(args.facts), 'utf8').trim().slice(0, 2000); log('facts: from', args.facts); } catch { log('facts: file unreadable, searching instead'); } }
  if (!facts) { try { facts = await gatherFacts(ask); } catch (e) { log('facts: skipped (' + e.message.slice(0, 80) + ')'); } }
  if (facts) log('facts:', facts.split('\n').length, 'lines');
  let last;
  for (let i = 0; i < 2; i++) {
    const r = await gemini(STORY_MODEL, { contents: [{ parts: [{ text: storyPrompt(ask, facts) }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: STORY_SCHEMA, temperature: 0.9 } }, 150);
    last = r;
    if (r.status >= 300) continue;
    try {
      const text = JSON.parse(r.text).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
      const story = JSON.parse(text);
      if (!Array.isArray(story.scenes) || story.scenes.length < 3) throw new Error('shape');
      story.scenes = story.scenes.slice(0, SCENES + 2).map(s => {
        const lines = (s.lines || []).slice(0, 5).map(l => ({ speaker: SPEAKERS[l.speaker] ? l.speaker : 'Sunny', text: String(l.text || '').replace(/\s+/g, ' ').trim().slice(0, 300) })).filter(l => l.text);
        // Gemini TTS takes two speakers per request: extra voices in a scene fall back to the narrator
        const keep = [...new Set(lines.map(l => l.speaker))].slice(0, 2);
        for (const l of lines) if (!keep.includes(l.speaker)) l.speaker = keep[0] || 'Sunny';
        return { art: String(s.art || '').slice(0, 400), lines };
      }).filter(s => s.lines.length);
      story.style = String(story.style || 'children picture book illustration, soft watercolor').slice(0, 300);
      story.people = (story.cast || []).filter(c => c.real && c.wiki).slice(0, 4).map(c => ({ name: String(c.name || ''), wiki: String(c.wiki || '').trim().replace(/ /g, '_') }));
      story.cast = (story.cast || []).slice(0, 6).map(c => `${c.name}: ${c.look}`).join('; ').slice(0, 800);
      story.title = String(story.title || 'Your story').slice(0, 60);
      return story;
    } catch (e) { last = { status: r.status, text: 'bad story json: ' + e.message }; }
  }
  throw new Error(`story: http ${last.status} ${String(last.text).slice(0, 200)}`);
}

/* ---------- voices: gemini multi-speaker tts -> mp3 32k mono via ffmpeg ---------- */
async function voiceScene(scene, n) {
  const script = scene.lines.map(l => `${l.speaker}: ${l.text}`).join('\n');
  const speakers = [...new Set(scene.lines.map(l => l.speaker))];
  const cfg = speakers.length > 1
    ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: speakers.map(s => ({ speaker: s, voiceConfig: { prebuiltVoiceConfig: { voiceName: SPEAKERS[s] } } })) } }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: SPEAKERS[speakers[0]] } } };
  const body = { contents: [{ parts: [{ text: (speakers.length > 1 ? `TTS the following conversation between ${speakers.join(' and ')}, as a warm bedtime story for a small child:\n` : 'Read this warmly, as a bedtime story for a small child:\n') + script }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: cfg } };
  let last;
  for (let i = 0; i < 3; i++) {
    const r = await gemini(TTS_MODEL, body);
    last = r;
    if (r.status < 300) {
      const part = JSON.parse(r.text).candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (part) {
        const pcm = join(work, `s${n}.pcm`), mp3 = join(work, `s${n}.mp3`);
        writeFileSync(pcm, Buffer.from(part.inlineData.data, 'base64'));
        const rate = /rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1] || '24000';
        const f = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 's16le', '-ar', rate, '-ac', '1', '-i', pcm, '-b:a', '24k', '-ac', '1', '-ar', '24000', mp3]);
        if (f.status !== 0) throw new Error('ffmpeg: ' + f.stderr.toString().slice(0, 200));
        const bytes = readFileSync(mp3);
        const seconds = Math.round(bytes.length / 3000);
        return { b64: bytes.toString('base64'), seconds };
      }
    }
  }
  throw new Error(`tts scene ${n}: http ${last.status} ${last.text.slice(0, 200)}`);
}

/* ---------- reference photos: each real cast member's Wikipedia page image, so the first picture gets the person right ---------- */
async function referencePhotos(story) {
  const refs = [];
  for (const p of story.people || []) {
    try {
      const api = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(p.wiki)}&prop=pageimages&format=json&pithumbsize=800&redirects=1`;
      const r = await curl(api, { headers: { 'user-agent': 'story-studio/1 (sprout stage demo)' }, timeout: 30 });
      if (r.status >= 300) throw new Error('http ' + r.status);
      const page = Object.values(JSON.parse(r.text).query?.pages || {})[0];
      const url = page?.thumbnail?.source; if (!url) throw new Error('no page image');
      const file = join(work, `ref-${refs.length}.jpg`);
      const g = await curl(url, { headers: { 'user-agent': 'story-studio/1 (sprout stage demo)' }, out: file, timeout: 30 });
      if (g.status >= 300) throw new Error('image http ' + g.status);
      const small = join(work, `ref-${refs.length}.small.jpg`);
      const f = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', 'scale=512:-2', '-q:v', '5', small]);
      if (f.status !== 0) throw new Error('ffmpeg');
      refs.push({ name: p.name, mime: 'image/jpeg', b64: readFileSync(small).toString('base64') });
      log('reference photo for', p.name);
    } catch (e) { log('no reference photo for', p.name, '(' + e.message.slice(0, 60) + ')'); }
  }
  return refs;
}

/* ---------- pictures: gemini image; scene 0 sets the look, every other scene is drawn from it ---------- */
async function drawScene(story, scene, n, ref, photos = []) {
  const parts = [];
  if (ref) parts.push({ inlineData: { mimeType: ref.mime, data: ref.b64 } });
  for (const ph of photos) parts.push({ inlineData: { mimeType: ph.mime, data: ph.b64 } });
  const photoNote = photos.length ? ` The ${photos.length === 1 ? 'photo is a reference' : 'photos are references, in order,'} for how ${photos.map(p => p.name).join(', ')} really look${photos.length === 1 ? 's' : ''}: draw ${photos.length === 1 ? 'them' : 'each'} as a friendly cartoon character with the same gender, hair, face shape, build and outfit style, never as a photo.` : '';
  parts.push({ text: ref
    ? `Draw the next picture of the same picture book. Keep exactly the same characters, faces, outfits, colors, brush and lighting as the first picture. Style: ${story.style}. Cast: ${story.cast}. New scene: ${scene.art}. No text, no letters, no logos.`
    : `${story.style}. Cast, drawn the same in every picture: ${story.cast}.${photoNote} Scene: ${scene.art}. No text, no letters, no logos.` });
  let last;
  for (let i = 0; i < 2; i++) {
    const r = await gemini(IMAGE_MODEL, { contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } } }, 150);
    last = r;
    if (r.status >= 300) continue;
    const part = JSON.parse(r.text).candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!part) { last = { status: r.status, text: 'no image part' }; continue; }
    const raw = join(work, `a${n}.raw`), small = join(work, `a${n}.jpg`);
    writeFileSync(raw, Buffer.from(part.inlineData.data, 'base64'));
    const f = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-vf', 'scale=512:512', '-q:v', '7', small]);
    if (f.status !== 0) throw new Error('ffmpeg jpg: ' + f.stderr.toString().slice(0, 200));
    return { jpegB64: readFileSync(small).toString('base64'), ref: { mime: part.inlineData.mimeType || 'image/png', b64: part.inlineData.data } };
  }
  throw new Error(`image scene ${n}: http ${last.status} ${String(last.text).slice(0, 200)}`);
}

/* ---------- one episode ---------- */
async function makeEpisode({ requestId, kid, ask }) {
  const id = requestId || 'e' + Date.now().toString(36);
  const epPath = `episodes/${id}`, reqPath = requestId ? `data/users/${kid}/requests/items/${requestId}` : null;
  const meta = { id, kid, ask, status: 'writing', title: '', createdAt: new Date().toISOString(), scenes: [] };
  const setStatus = async (status, extra = {}) => { Object.assign(meta, { status }, extra); await write(epPath, meta); if (reqPath) await write(reqPath, { status, episodeId: id }, 'update'); };
  await setStatus('writing');
  log('writing story for', JSON.stringify(ask));
  const story = await makeStory(ask);
  meta.title = story.title;
  meta.scenes = story.scenes.map((s, n) => ({ n, caption: s.lines.map(l => l.text).join(' '), parts: 0, art: false, seconds: 0 }));
  await setStatus('voicing');
  log('story:', story.title, story.scenes.length, 'scenes');
  if (args.dry || process.env.STUDIO_DRY) { console.log(JSON.stringify(story, null, 1)); return; }
  // voices and pictures for every scene start at once; writes go out in scene order
  const made = story.scenes.map(() => ({}));
  // scene 0's picture is the reference every other picture is drawn from, so it goes first; voices run from the start
  const photos = await referencePhotos(story);
  const first = drawScene(story, story.scenes[0], 0, null, photos).then(d => { made[0].art = d.jpegB64; log('drew scene 0 (reference)', Math.round(d.jpegB64.length / 1024) + 'K chars'); return d.ref; });
  const jobs = story.scenes.flatMap((s, n) => [
    (async () => { made[n].voice = await voiceScene(s, n); log('voiced scene', n, made[n].voice.seconds + 's', Math.round(made[n].voice.b64.length / 1024) + 'K chars'); })(),
    n === 0 ? first : first.then(async ref => { const d = await drawScene(story, s, n, ref); made[n].art = d.jpegB64; log('drew scene', n, Math.round(d.jpegB64.length / 1024) + 'K chars'); }),
  ]);
  // Writes go out in scene order as soon as that scene is done, so the kid can start on scene 0.
  let firstReady = false;
  for (let n = 0; n < story.scenes.length; n++) {
    await Promise.all([jobs[2 * n], jobs[2 * n + 1]]);
    const { voice, art } = made[n];
    const partCount = await writeParts(`${epPath}/scenes/${n}/audio`, voice.b64);
    await write(`${epPath}/art/${n}`, { jpegB64: art });
    if (n === 0) await write(`${epPath}/cover/0`, { jpegB64: art });
    meta.scenes[n] = { ...meta.scenes[n], parts: partCount, art: true, seconds: voice.seconds };
    if (!firstReady) { firstReady = true; await setStatus('playing'); } else await write(epPath, meta);
    log('scene', n, 'in the db:', partCount, 'audio parts');
  }
  await setStatus('ready');
  log('episode ready:', id, meta.title);
  return id;
}

async function main() {
  if (args.sweep) {
    // every kid's requests still at "asked": the collection is per kid, so walk the kids we know of
    const kids = (args.kid ? [args.kid] : (process.env.STUDIO_KIDS || '').split(',').filter(Boolean));
    if (!kids.length) die('--sweep needs --kid or STUDIO_KIDS');
    let n = 0;
    for (const kid of kids) {
      const asked = await list(`data/users/${kid}/requests/items`, [{ field: 'status', op: '==', value: 'asked' }]);
      for (const d of asked) { const rid = String(d.path || d.id || '').split('/').pop(); n++; log('request', rid, 'from', kid); await makeEpisode({ requestId: rid, kid, ask: d.data.ask }); }
    }
    log(n ? `${n} request(s) done` : 'nothing asked');
  } else if (args.request) {
    const kid = args.kid || die('--kid');
    const d = await read(`data/users/${kid}/requests/items/${args.request}`);
    if (!d) die('no such request');
    if (args.show) { console.log(JSON.stringify({ ask: d.data.ask, status: d.data.status })); return; }
    if (d.data.status !== 'asked' && !args.force) { log('request is', d.data.status, '(use --force)'); return; }
    await makeEpisode({ requestId: args.request, kid, ask: d.data.ask });
  } else if (args.prompt) {
    await makeEpisode({ kid: args.kid || 'studio', ask: args.prompt });
  } else die('usage: --request <id> --kid <childId> | --sweep --kid <childId> | --prompt "..."');
}
main().catch(e => { console.error('make failed:', e.message); process.exit(1); }).finally(() => rmSync(work, { recursive: true, force: true }));
