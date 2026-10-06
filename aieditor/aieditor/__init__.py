"""Auto Editor — raw narration in, edited video out (host-side worker package).

Stage 1 (this package today): Descript share link -> source download -> Groq word
transcript -> wav2vec2 forced alignment -> Claude picks the best take of every line
-> frame-exact edit decision list -> preview render.

The Lab is only the control plane (lab/server/src/aieditor/). Everything that
touches media runs here, in bin/aieditor-worker, on the host.
"""
