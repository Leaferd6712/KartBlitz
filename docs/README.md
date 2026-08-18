# KartBlitz docs

## Online mode architecture

**Show anyone:** open [online-mode.html](online-mode.html) in a browser (double-click, or put `docs/` on Netlify). No build step.

### TypeScript vs HTML

The panel beside Cursor chat is a **Cursor Canvas**: a React/TypeScript file that imports `cursor/canvas`. Only Cursor renders that live sidebar.

| File | What it is | How to view |
|------|------------|-------------|
| [online-mode.html](online-mode.html) | Standalone HTML | Double-click or any static host |
| [online-mode-architecture.canvas.tsx](online-mode-architecture.canvas.tsx) | Canvas source (TS + React) | Cursor only; see below |

**Cursor sidebar (what you saw in chat):** Cursor loads canvases from its project `canvases/` folder, not from `docs/`. In this chat, open [KartBlitz online architecture](C:\Users\663208\.cursor\projects\c-Users-663208-Downloads-KartBlitz\canvases\online-mode-architecture.canvas.tsx). The copy in `docs/` is for git so the source is in the repo.

Friends without Cursor should use the HTML file.
