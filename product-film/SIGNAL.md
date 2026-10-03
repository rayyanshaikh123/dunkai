# Dunk AI — Signal

A separate 32-second launch film. The existing `DunkAI-Launch-4K` composition, its scene files, audio and exports are preserved. New implementation lives entirely under `src/signal`, with audio under `public/signal`. The shared root only registers the new film and its seven editable scene compositions.

## Creative direction

The camera follows an idea becoming an engineering artifact. Fragmented work collapses into a prompt. Generate becomes a blue aperture into the system. The processor fills the frame and reveals component packages. Packages flatten into BOM rows; rows expand into physical board layers. The assembled board accelerates into a processor close-up, revealing firmware. A line of logic becomes the transition into the unified project and brand.

Graphite, soft blue, Figtree and Google Sans Code come from the actual frontend. Kevin is the original animated WebP brand asset. There is no voiceover or scenery footage.

## Timeline

| Frames at 60 fps | Motion |
|---|---|
| 0–189 | Kinetic problem statement; scattered work becomes prompt |
| 190–429 | Character-synchronized typing, click, camera dive |
| 430–669 | Architecture draws outward; camera enters processor |
| 670–939 | Packages become BOM rows and board layers |
| 940–1299 | Physical assembly, routing, macro movement |
| 1300–1569 | Firmware reveal, folding text and signal wipe |
| 1570–1919 | Artifacts converge; Dunk AI and Start building |

## Authenticity

Product capabilities and fonts are grounded in `frontend/app/layout.tsx` and the workspace architecture/BOM/PCB/code views. Part IDs, names, packages, nets and dimensions derive from the repository's PCB IR, copied in `src/pcb-ir.json`. The board geometry is an editorial reconstruction, not a validated or manufacturing-ready layout. Firmware text is illustrative pseudocode. No device test or successful fabrication is claimed.

## Audio

`node scripts/signal-audio.cjs` generates an original 120 BPM electronic score and frame-synchronized Foley, each 32 seconds, 48 kHz stereo. The typing sounds use the same sentence, character count and frame interval as the prompt animation. Other events align with the click, architecture nodes, component placement, routing and closing CTA.

## Preview and output

Select `DunkAI-Signal-4K` in Studio. Output is 3840 × 2160, 60 fps. The 1920 × 1080 design canvas scales to native UHD, and the physical board uses a DPR-2 WebGL canvas.

```sh
npm run lint
npx remotion render DunkAI-Signal-4K out/dunk-ai-signal-4k.mp4 --codec=h264 --crf=16 --pixel-format=yuv420p --concurrency=3
```

Review frames and a full review encode are stored under ignored `out/`. Visual inspection includes transition samples, typography, board framing and the closing CTA. The film uses frame-driven transforms, masks, curves and camera motion; it has no CSS animation or nondeterministic visual randomness.
