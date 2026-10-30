// Story Studio wake: the canvas can only GET an approved site through Sprout (sprout.net.fetch),
// so this hop turns that GET into the POST that fires Han's Claude Code routine. The routine
// then reads the request from the canvas db and makes the episode. Nothing from the kid rides
// the wake except the request id and the kid id the canvas already holds.
// Env: STUDIO_KEY (shared with the canvas), ROUTINE_FIRE_URL, ROUTINE_TOKEN, STUDIO_CANVAS_ID.
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request) {
  const url = new URL(request.url), q = k => url.searchParams.get(k) || '';
  if (!process.env.STUDIO_KEY || q('key') !== process.env.STUDIO_KEY) return json({ ok: false, code: 'not_granted' }, 401);
  const req = q('req'), kid = q('kid');
  if (!/^[a-z0-9_-]{4,40}$/i.test(req) || !/^[0-9a-f-]{36}$/i.test(kid)) return json({ ok: false, code: 'bad_request' }, 400);
  const fire = process.env.ROUTINE_FIRE_URL, token = process.env.ROUTINE_TOKEN;
  if (!fire || !token) return json({ ok: false, code: 'not_configured' });
  try {
    const r = await fetch(fire, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ text: `Story Studio: request ${req} from kid ${kid} on canvas ${process.env.STUDIO_CANVAS_ID || ''} is waiting. Run one wake now.` }), signal: AbortSignal.timeout(8000) });
    return json({ ok: r.ok, status: r.status });
  } catch (e) {
    return json({ ok: false, code: 'fire_failed', detail: String(e && e.message).slice(0, 80) });
  }
}
