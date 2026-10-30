# Story Studio: finish the cloud routine (brief for Claude on claude.ai)

Context. Story Studio is a Sprout canvas on the Sprout stage server where my kid asks for a story out loud. The canvas writes a request document into the canvas db, then pings a Vercel hop that fires a Claude Code routine. The routine clones a repo and runs `studio/make.mjs`, which makes the episode with Gemini (story, two voices, a picture per scene) and writes it back into the canvas db. The canvas plays it. Everything is built and proven from my Mac; the routine itself is created but cannot complete yet because its environment lacks network access to the stage server and the env vars.

Routine: "Story Studio podcast maker (stage)", id trig_01TCgRhQFRC676CPfdwaZS5m, enabled, cron 17 */6 * * * (backstop sweep), repo https://github.com/Hanlee0707/story-studio (public), environment claude-code-default (env_018s6eHsqBkaU7eTaPt6yW6j).

Do these three things, then test.

1. Environment claude-code-default, Network access: add the host
   sprout-server-stage-606162082569.europe-west3.run.app
   (generativelanguage.googleapis.com and github.com already pass; do not add any other host.)

2. Environment claude-code-default, Environment variables (add all four):
   GEMINI_API_KEY = <value of ~/.config/sprout/gemini-social-factory.key on my Mac>
   SPROUT_TOKEN   = <value of ~/.config/sprout/story-studio-stage-token on my Mac>
   CANVAS_ID      = e9adadc9-27f9-43bf-8039-83daa23118ed
   STUDIO_KIDS    = 019fec86-09d1-7474-9196-01b3fdc70da7

3. Routine trig_01TCgRhQFRC676CPfdwaZS5m: create its API token (the one that lets an outside caller fire it). Show it to me once; I will put it on Vercel as ROUTINE_TOKEN. Do not paste it anywhere else.

Test. Run the routine once by hand. A good run clones the repo and runs
   node studio/make.mjs --sweep
and ends with the line `nothing asked` (no request is waiting) within about 30 s. If it ends with "missing env <NAME>", step 2 is incomplete. If the script fails with "curl ... CONNECT tunnel failed, response 403" against the stage host, step 1 is incomplete. Any other failure: paste the last 20 lines of the run log back to me.

Do not change the routine's prompt, schedule, repo, or model, and do not run the maker against any other canvas id.
