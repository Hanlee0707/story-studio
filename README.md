# Story Studio

A Sprout canvas where a kid asks for a story out loud, a maker turns it into a short two-voice podcast with a picture per scene, and the episode lands back in the same canvas as canvas-db documents (base64 audio and jpeg), so the page plays it with no new canvas version.

- `canvas/index.html`: the kid page (Sprout canvas, stage).
- `studio/make.mjs`: the maker (node 20+, curl, ffmpeg). Reads a request document, writes the episode documents.
- `vercel/wake.js`: the hop that turns the canvas's approved GET into the POST that fires the Claude Code routine.
- `imagine-2026-10-29.md`: how it was imagined and measured.

Secrets live in env, never here.
