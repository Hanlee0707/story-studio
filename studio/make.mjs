#!/usr/bin/env node
// Story Studio maker: turns a kid's story request (a document in the Story Studio canvas db)
// into a short two-voice podcast with a picture per scene, and writes it back into the same
// canvas db as base64 documents, so the page plays it with no new canvas version.
//
// Runs anywhere with node >= 20, curl and ffmpeg (Han's Mac, a Claude Code cloud routine).
// All HTTP goes through curl so an outbound proxy in the cloud sandbox is honoured.
//
// Env: SPROUT_MCP_URL, SPROUT_TOKEN (connection token, canvas:read+write), CANVAS_ID,
//      ANTHROPIC_API_KEY, GEMINI_API_KEY, FAL_KEY. Optional: STUDIO_MODEL (claude), STUDIO_DRY=1.
// Usage: node make.mjs --request <id> --kid <childId>   (one request)
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
const MODEL = env('STUDIO_MODEL', 'claude-sonnet-5-5');
const CHUNK = 60000;            // base64 chars per db document (moderation takes 20 x 4000 per request; 60K leaves room)
const SPEAKERS = { Sunny: 'Kore', Pip: 'Puck' };
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
async function write(path, data, action = 'set', tries = 8) {
  for (let i = 1; ; i++) {
    const res = await tool('canvas_write_documents', { canvasId: CANVAS, writes: [{ action, path, data }] });
    const r = res.results?.[0];
    if (r?.ok) return r.version;
    const code = r?.error?.code;
    if (code === 'unavailable' && i < tries) { await sleep(1500 * i); continue; }
    throw new Error(`write ${path}: ${JSON.stringify(r?.error || res).slice(0, 300)}`);
  }
}
const read = async (path) => (await tool('canvas_get_document', { canvasId: CANVAS, path })).doc;
const list = async (path, where) => (await tool('canvas_list_documents', { canvasId: CANVAS, path, ...(where ? { where } : {}) })).docs || [];

/* ---------- the story ---------- */
function storyPrompt(ask) {
  return `You write a tiny audio story for a four year old who asked, in her own words: "${ask}".
Return ONLY JSON: {"title": string (max 6 words), "scenes": [5 scenes]}. Each scene: {"art": string, "lines": [2 to 4 lines]}.
A line is {"speaker": "Sunny" | "Pip", "text": string}. Sunny is the warm storyteller; Pip is a small excited sidekick who reacts, asks, and sometimes makes a sound effect. Mostly Sunny.
Rules: gentle, funny, cozy, nothing scary, nothing sad at the end; short sentences a four year old follows by ear; if the ask names BTS or its members (Jin, Suga, J-Hope, RM, Jimin, V, Jungkook), they are kind, playful friends in the story; keep real people as characters only, invent nothing about their private lives. One sentence of plot per line. Total about 230 words of spoken text. End warmly in scene 5.
"art" is a picture prompt for that scene: "children's picture book illustration, soft watercolor, ..." describing the place and action, no text in the image, no logos, friendly faces, at most 40 words.`;
}
async function makeStory(ask) {
  const r = await curl('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' }, body: { model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: storyPrompt(ask) }] } });
  if (r.status >= 300) throw new Error(`claude http ${r.status}: ${r.text.slice(0, 300)}`);
  const text = JSON.parse(r.text).content.filter(b => b.type === 'text').map(b => b.text).join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const story = JSON.parse(json);
  if (!story.title || !Array.isArray(story.scenes) || story.scenes.length < 3) throw new Error('story shape');
  story.scenes = story.scenes.slice(0, 6).map(s => ({ art: String(s.art || '').slice(0, 400), lines: (s.lines || []).slice(0, 5).map(l => ({ speaker: SPEAKERS[l.speaker] ? l.speaker : 'Sunny', text: String(l.text || '').slice(0, 300) })).filter(l => l.text) }));
  return story;
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
    const r = await curl('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env('GEMINI_API_KEY') }, body, timeout: 120 });
    last = r;
    if (r.status < 300) {
      const part = JSON.parse(r.text).candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (part) {
        const pcm = join(work, `s${n}.pcm`), mp3 = join(work, `s${n}.mp3`);
        writeFileSync(pcm, Buffer.from(part.inlineData.data, 'base64'));
        const rate = /rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1] || '24000';
        const f = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 's16le', '-ar', rate, '-ac', '1', '-i', pcm, '-b:a', '32k', '-ac', '1', '-ar', '24000', mp3]);
        if (f.status !== 0) throw new Error('ffmpeg: ' + f.stderr.toString().slice(0, 200));
        const bytes = readFileSync(mp3);
        const seconds = Math.round(bytes.length / 4000);
        return { b64: bytes.toString('base64'), seconds };
      }
    }
  }
  throw new Error(`tts scene ${n}: http ${last.status} ${last.text.slice(0, 200)}`);
}

/* ---------- pictures: fal flux schnell -> 512 jpeg ~40 KB ---------- */
async function drawScene(scene, n) {
  const r = await curl('https://fal.run/fal-ai/flux/schnell', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Key ${env('FAL_KEY')}` }, body: { prompt: scene.art, image_size: 'square', num_inference_steps: 4, output_format: 'jpeg', num_images: 1, enable_safety_checker: true }, timeout: 90 });
  if (r.status >= 300) throw new Error(`fal http ${r.status}: ${r.text.slice(0, 200)}`);
  const url = JSON.parse(r.text).images?.[0]?.url; if (!url) throw new Error('fal: no image');
  const raw = join(work, `a${n}.raw.jpg`), small = join(work, `a${n}.jpg`);
  await curl(url, { out: raw, timeout: 60 });
  const f = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-vf', 'scale=512:512', '-q:v', '7', small]);
  if (f.status !== 0) throw new Error('ffmpeg jpg: ' + f.stderr.toString().slice(0, 200));
  return readFileSync(small).toString('base64');
}

/* ---------- one episode ---------- */
async function makeEpisode({ requestId, kid, ask }) {
  const id = requestId || 'e' + Date.now().toString(36);
  const epPath = `episodes/${id}`, reqPath = requestId ? `data/users/${kid}/requests/${requestId}` : null;
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
  const jobs = story.scenes.flatMap((s, n) => [
    (async () => { made[n].voice = await voiceScene(s, n); log('voiced scene', n, made[n].voice.seconds + 's', Math.round(made[n].voice.b64.length / 1024) + 'K chars'); })(),
    (async () => { made[n].art = await drawScene(s, n); log('drew scene', n, Math.round(made[n].art.length / 1024) + 'K chars'); })(),
  ]);
  // Writes go out in scene order as soon as that scene is done, so the kid can start on scene 0.
  let firstReady = false;
  for (let n = 0; n < story.scenes.length; n++) {
    await Promise.all([jobs[2 * n], jobs[2 * n + 1]]);
    const { voice, art } = made[n];
    const parts = [];
    for (let i = 0; i < voice.b64.length; i += CHUNK) parts.push(voice.b64.slice(i, i + CHUNK));
    for (let k = 0; k < parts.length; k++) await write(`${epPath}/scenes/${n}/audio/${k}`, { k, b64: parts[k] });
    await write(`${epPath}/scenes/${n}/art`, { jpegB64: art });
    meta.scenes[n] = { ...meta.scenes[n], parts: parts.length, art: true, seconds: voice.seconds };
    if (!firstReady) { firstReady = true; await setStatus('playing'); } else await write(epPath, meta);
    log('scene', n, 'in the db:', parts.length, 'audio parts');
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
      const asked = await list(`data/users/${kid}/requests`, [{ field: 'status', op: '==', value: 'asked' }]);
      for (const d of asked) { n++; log('request', d.id, 'from', kid); await makeEpisode({ requestId: d.id, kid, ask: d.data.ask }); }
    }
    log(n ? `${n} request(s) done` : 'nothing asked');
  } else if (args.request) {
    const kid = args.kid || die('--kid');
    const d = await read(`data/users/${kid}/requests/${args.request}`);
    if (!d) die('no such request');
    if (d.data.status !== 'asked' && !args.force) { log('request is', d.data.status, '(use --force)'); return; }
    await makeEpisode({ requestId: args.request, kid, ask: d.data.ask });
  } else if (args.prompt) {
    await makeEpisode({ kid: args.kid || 'studio', ask: args.prompt });
  } else die('usage: --request <id> --kid <childId> | --sweep --kid <childId> | --prompt "..."');
}
main().catch(e => { console.error('make failed:', e.message); process.exit(1); }).finally(() => rmSync(work, { recursive: true, force: true }));
