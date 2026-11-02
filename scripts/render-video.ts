/**
 * npm run demo:render   docs/video/pursestrings-demo.cast + viewer.html -> docs/video/pursestrings-demo.mp4
 *
 * 1. The narration is NARRATION below. Each line is anchored to the moment its event appears in the cast
 *    (`at`: text in the recorded output, searched forward from the previous anchor). Lines are cut into
 *    caption-sized pieces (whole sentences, at most two lines on screen) and every piece is spoken with
 *    Kokoro TTS (local, Apache-2.0) into its own clip, so each caption is on screen exactly while its
 *    words are spoken.
 * 2. Timeline: each line starts when its event appears on screen. Between lines the recording plays at
 *    up to 2.5x speed, or holds on its last frame while the voice finishes. The last line is spoken over
 *    the end card.
 * 3. Frames are rendered by seeking viewer.html (`__guardViewer.seekVideo`) in headless Chromium
 *    (Playwright) and piped to ffmpeg. Subtitles are drawn by the viewer (burned in) and also added as a
 *    soft track and an .srt file.
 * 4. Audio clips are placed with adelay, mixed, loudness-normalised (-16 LUFS) and muxed.
 *
 *   --voice am_michael   Kokoro voice (--tts say: a macOS voice, default Samantha)
 *   --speed 1.0          Kokoro speed          --tts kokoro|say   (--rate 182: words per minute for say)
 *   --fps 30   --max-seconds 140 (fails if longer: X's limit without Premium is 2:20)
 *   --plan               print where each line starts in the cast and exit
 *   KOKORO_DIR (default ~/.local/kokoro): kokoro-v1.0.onnx, voices-v1.0.bin, tts.py and .venv
 *
 * Rebuild viewer.html first if the template changed: npm run demo:record -- --viewer-only
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { ROOT } from "../src/demo/setup";

const { values } = parseArgs({
  options: {
    fps: { type: "string", default: "30" },
    "max-seconds": { type: "string", default: "140" },
    tts: { type: "string", default: "kokoro" },
    voice: { type: "string" },
    speed: { type: "string", default: "1.0" },
    rate: { type: "string", default: "182" },
    plan: { type: "boolean", default: false },
  },
});
const TTS = values.tts!;
if (TTS !== "kokoro" && TTS !== "say") throw new Error("--tts must be kokoro or say");
const VOICE = values.voice ?? (TTS === "kokoro" ? "am_michael" : "Samantha");
const KOKORO = process.env.KOKORO_DIR ?? join(homedir(), ".local/kokoro");
const FPS = Number(values.fps);
const OUT = join(ROOT, "docs/video");
const work = join(tmpdir(), `ps-render-${Date.now()}`);
mkdirSync(work, { recursive: true });
const MAX_SPEED = 2.5;
const GAP = 0.3;
const PIECE_GAP = 0.18;
const END_HOLD = 1.6;
/** Characters that fit in two lines of the burned-in caption (the viewer shrinks the font if a line still wraps to three). */
const MAX_CAPTION = 96;

// ---------------------------------------------------------------- narration
/** at: where the line starts (text in the recorded output, or a scene/chat event as `<<type text>>`); none = same moment as the previous line. */
const NARRATION: Array<{ at?: string | RegExp; text: string; say?: string; endCard?: true }> = [
  { at: "PurseStrings  a policy firewall", text: "One injected message can drain an AI agent's wallet." },
  { text: "PurseStrings: your agent carries the purse, you hold the strings." },
  { at: "<<scene 1>>", text: "This runs on a local NEAR node, with the real PurseStrings contract." },
  { at: "agent key", text: "The agent's key can only call three methods on the vault." },
  { at: "the agent tries a plain", text: "A plain transfer with that key is rejected by the protocol itself." },
  { at: "<<scene 2>>", text: "A normal request: pay a contractor 0.2 NEAR." },
  { at: /risk layer {3,}ALLOW/, text: "The risk layer says ALLOW. The contract checks the caps and executes." },
  { at: "<<scene 3>>", text: 'Now a fake "system notice" tells the agent to send USDC to a drainer.' },
  { at: /agent proposes\s+send/, text: "Our agent is gullible on purpose, so it tries." },
  { at: /risk layer {3,}BLOCK/, text: "PurseStrings refuses before signing: an injection, a scam link, a fake USDC token, a denylisted receiver." },
  { at: "PurseStrings notifies the owner", text: "The owner gets the reasons on Telegram." },
  { at: "<<scene 4>>", text: "An honest invoice, but over the 0.5 NEAR per-transaction cap." },
  { at: "OVER_TX_CAP", text: "The contract blocks it on chain, and the agent asks the owner." },
  { at: "PurseStrings sends the request", text: "The request reaches the Telegram bot, here in console mode, with a risk check of the receiver." },
  { at: "<<tap", text: "One tap on Approve, and the bot signs approve_request with the owner's key. Executed." },
  { at: "<<scene 5>>", text: "Now assume the agent is fully compromised and skips our checks." },
  { at: "RECIPIENT_DENYLISTED", text: "The contract still refuses: the receiver is denylisted, a hard block no approval can override." },
  { at: "The owner is told", text: "The owner is told." },
  { at: "<<scene 6>>", text: "The same bot works in any group chat: paste an account, a token or a link." },
  { at: "<<user /check@PurseStringsBot wrap-near.near", text: "A look-alike of wrap.near: BLOCK." },
  { at: "<<user /check@PurseStringsBot https://near.org", text: "A phishing link with near.org in it: BLOCK." },
  { at: "<<user /check@PurseStringsBot wrap.near", text: "The real wrap.near: ALLOW." },
  { at: "<<scene 7>>", text: "Swaps are checked with NEAR Intents quotes, as dry runs." },
  { at: "swap 1 NEAR", text: "A normal quote passes. The same swap with 40% slippage is blocked." },
  { at: "(quote recorded", text: "Daily caps are a rolling 24-hour window." },
  { at: "On chain after the story", text: "The contract is also deployed on NEAR testnet, and the code is MIT-licensed." },
  { text: "What should an agent wallet always refuse?", endCard: true },
];

// ---------------------------------------------------------------- anchors in the cast
const castLines = readFileSync(join(OUT, "pursestrings-demo.cast"), "utf8").trim().split("\n").slice(1).map((l) => JSON.parse(l) as [number, string, string]);
const endAt = castLines.at(-1)![0];
const plain = castLines.map(([t, , d]) => ({
  t,
  text: d
    .replace(/\x1b\]1337;GuardChat=([^\x07]*)\x07/g, (_, b: string) => {
      const e = JSON.parse(Buffer.from(b, "base64").toString("utf8")) as { type: string; n?: number; text?: string };
      return `<<${e.type}${e.n != null ? ` ${e.n}` : ""}${e.text ? ` ${e.text}` : ""}>>`;
    })
    .replace(/\x1b\[[0-9;]*m/g, ""),
}));
let from = 0;
const cues = NARRATION.map((n, i) => {
  if (n.at != null) {
    const at = n.at;
    const k = plain.findIndex((x, j) => j >= from && (typeof at === "string" ? x.text.includes(at) : at.test(x.text)));
    if (k < 0) throw new Error(`narration line ${i + 1}: ${String(at)} not found in the cast after ${plain[from]?.t ?? 0} s`);
    from = k;
  }
  return { id: `n${String(i + 1).padStart(2, "0")}`, t: plain[from]!.t, text: n.text, say: n.say ?? n.text, endCard: n.endCard ?? false };
});
if (values.plan) {
  for (const c of cues) console.log(`${c.t.toFixed(2).padStart(7)}  ${c.text}`);
  process.exit(0);
}

// ---------------------------------------------------------------- captions and speech
/** Spoken forms the TTS gets wrong otherwise (the captions keep the written form). */
const SPEECH: Array<[RegExp, string]> = [
  [/\bUSDC\b/g, "U S D C"],
  [/\bdenylisted\b/g, "deny-listed"],
  [/\bapprove_request\b/g, "approve request"],
  [/\b([a-z-]+)\.(near|org)\b/g, "$1 dot $2"],
];
const spoken = (s: string) => SPEECH.reduce((x, [re, to]) => x.replace(re, to), s);
const sentences = (s: string) => s.split(/(?<=[.?!])\s+(?=\S)/);

/** Whole sentences grouped into caption-sized pieces; text and speech are split the same way when they have the same sentences. */
function pieces(text: string, say: string): Array<{ text: string; say: string }> {
  const ts = sentences(text);
  const ss = sentences(say);
  if (ts.length !== ss.length) return [{ text, say }];
  const out: Array<{ text: string; say: string }> = [];
  ts.forEach((t, i) => {
    const last = out.at(-1);
    if (last && last.text.length + 1 + t.length <= MAX_CAPTION) {
      last.text += " " + t;
      last.say += " " + ss[i]!;
    } else out.push({ text: t, say: ss[i]! });
  });
  return out;
}

/** A caption longer than two lines is split at a clause boundary (or a space) near the middle. */
function splitCaption(text: string): string[] {
  if (text.length <= MAX_CAPTION) return [text];
  const target = text.length / Math.ceil(text.length / MAX_CAPTION);
  let best = -1;
  let cost = Infinity;
  for (const m of text.matchAll(/[,:;]?\s/g)) {
    const p = m.index! + m[0].length - 1;
    if (p > MAX_CAPTION || p < 12) continue;
    const c = Math.abs(p - target) + (m[0].length > 1 ? 0 : 14);
    if (c < cost) [best, cost] = [p, c];
  }
  if (best < 0) return [text];
  return [text.slice(0, best).trim(), ...splitCaption(text.slice(best).trim())];
}

const dur = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());
function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}: ${err.slice(-600)}`))));
  });
}
const speak = (say: string, file: string) =>
  TTS === "kokoro"
    ? run(join(KOKORO, ".venv/bin/python"), [join(KOKORO, "tts.py"), VOICE, values.speed!, spoken(say), file], KOKORO)
    : run("say", ["-v", VOICE, "-r", values.rate!, "-o", file, spoken(say)]);

type Piece = { text: string; say: string; file: string; dur: number; offset: number };
const jobs: Piece[] = [];
const plan = cues.map((c, i) => ({
  ...c,
  pieces: pieces(c.text, c.say).map((p, k): Piece => {
    const piece = { ...p, file: join(work, `line${String(i).padStart(2, "0")}-${k}.${TTS === "kokoro" ? "wav" : "aiff"}`), dur: 0, offset: 0 };
    jobs.push(piece);
    return piece;
  }),
}));
console.log(`speaking ${jobs.length} pieces of ${cues.length} lines with ${TTS} ${VOICE}${TTS === "kokoro" ? ` at ${values.speed}x` : ""}`);
let next = 0;
await Promise.all(
  Array.from({ length: TTS === "kokoro" ? 3 : 1 }, async () => {
    while (next < jobs.length) {
      const piece = jobs[next++]!;
      await speak(piece.say, piece.file);
      piece.dur = dur(piece.file);
    }
  }),
);
const clips = plan.map((c) => {
  let off = 0;
  for (const p of c.pieces) {
    p.offset = off;
    off += p.dur + PIECE_GAP;
  }
  return { ...c, dur: off - PIECE_GAP };
});

// ---------------------------------------------------------------- timeline
// map: [videoTime, castTime, speed] anchors; the viewer interpolates (speed, then hold).
const map: Array<[number, number, number]> = [];
const starts: number[] = [];
const first = clips[0]!;
let v = Math.min(0.6, first.t);
map.push([0, 0, first.t > 0 ? first.t / v : 1]);
for (let i = 0; i < clips.length; i++) {
  const c = clips[i]!;
  if (i > 0) v = starts[i - 1]! + Math.max(clips[i - 1]!.dur + GAP, (c.t - clips[i - 1]!.t) / MAX_SPEED);
  starts.push(v);
  const nextCast = i + 1 < clips.length ? clips[i + 1]!.t : endAt;
  const nextSpan = Math.max(c.dur + GAP, (nextCast - c.t) / MAX_SPEED);
  map.push([v, c.t, Math.max(1, (nextCast - c.t) / nextSpan)]);
}
const last = clips.at(-1)!;
const endV = starts.at(-1)! + Math.max(last.dur + GAP, (endAt - last.t) / MAX_SPEED);
map.push([endV, endAt, 1]);
const total = endV + END_HOLD;
const cardIdx = clips.findIndex((c) => c.endCard);
const endCardAt = cardIdx >= 0 ? starts[cardIdx]! : endV;
if (total > Number(values["max-seconds"])) throw new Error(`video would be ${total.toFixed(1)} s (limit ${values["max-seconds"]}): shorten the narration, raise --speed or cut the demo pauses`);

// Captions: one per caption-sized part, timed by its own clip (parts of one clip by their share of the characters).
// Inside a line a caption stays up until the next one starts, so a caption is on screen for every spoken word.
const subs: Array<{ start: number; end: number; text: string }> = [];
clips.forEach((c, i) => {
  const lineSubs: Array<{ start: number; end: number; text: string }> = [];
  for (const p of c.pieces) {
    const parts = splitCaption(p.text);
    const chars = parts.reduce((n, x) => n + x.length, 0);
    let t = starts[i]! + p.offset;
    for (const x of parts) {
      const d = (p.dur * x.length) / chars;
      lineSubs.push({ start: t, end: t + d, text: x });
      t += d;
    }
  }
  lineSubs.forEach((s, k) => (s.end = k + 1 < lineSubs.length ? lineSubs[k + 1]!.start : Math.min(s.end + 0.25, i + 1 < clips.length ? starts[i + 1]! : total)));
  subs.push(...lineSubs);
});
console.log(`${clips.length} lines, ${subs.length} captions, video ${total.toFixed(1)} s`);

// ---------------------------------------------------------------- srt
const ts = (s: number) => {
  const ms = Math.round(s * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
const srt = subs.map((s, i) => `${i + 1}\n${ts(s.start)} --> ${ts(s.end)}\n${s.text}\n`).join("\n");
writeFileSync(join(OUT, "pursestrings-demo.en.srt"), srt);

// ---------------------------------------------------------------- audio
const audio = join(work, "voice.m4a");
const placed = clips.flatMap((c, i) => c.pieces.map((p) => ({ file: p.file, at: Math.round((starts[i]! + p.offset) * 1000) })));
const inputs = placed.flatMap((p) => ["-i", p.file]);
const filters = placed.map((p, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${p.at}|${p.at}[a${i}]`).join(";");
execFileSync("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", `${filters};${placed.map((_, i) => `[a${i}]`).join("")}amix=inputs=${placed.length}:normalize=0,apad,atrim=0:${total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]`, "-map", "[out]", "-c:a", "aac", "-b:a", "160k", audio]);

// ---------------------------------------------------------------- frames
type Viewer = { __guardViewer: { setTimeline: (m: unknown, s: unknown, e: number) => void; seekVideo: (t: number) => void } };
const silent = join(work, "video.mp4");
const ff = spawn("ffmpeg", ["-y", "-v", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart", silent], { stdio: ["pipe", "inherit", "inherit"] });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(`file://${join(OUT, "viewer.html")}?clean=1`);
await page.evaluate(([m, s, e]) => (window as unknown as Viewer).__guardViewer.setTimeline(m, s, e), [map, subs, endCardAt] as const);
const frames = Math.ceil(total * FPS);
for (let k = 0; k < frames; k++) {
  await page.evaluate((t) => (window as unknown as Viewer).__guardViewer.seekVideo(t), k / FPS);
  const buf = await page.screenshot({ type: "jpeg", quality: 92 });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (k % 300 === 0) process.stdout.write(`frame ${k}/${frames}\n`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await browser.close();

// ---------------------------------------------------------------- mux
const mp4 = join(OUT, "pursestrings-demo.mp4");
execFileSync("ffmpeg", ["-y", "-v", "error", "-i", silent, "-i", audio, "-i", join(OUT, "pursestrings-demo.en.srt"), "-map", "0:v", "-map", "1:a", "-map", "2", "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng", "-t", total.toFixed(3), "-movflags", "+faststart", mp4]);
const mb = statSync(mp4).size / 1e6;
console.log(`wrote ${mp4}: ${dur(mp4).toFixed(1)} s, ${mb.toFixed(1)} MB`);
if (mb > 50) throw new Error("over 50 MB");
writeFileSync(
  join(OUT, "timeline.json"),
  JSON.stringify(
    {
      total,
      endCardAt,
      voice: TTS === "kokoro" ? `Kokoro TTS ${VOICE} at ${values.speed}x` : `macOS say ${VOICE}`,
      lines: clips.map((c, i) => ({ id: c.id, castT: c.t, videoT: Number(starts[i]!.toFixed(3)), dur: Number(c.dur.toFixed(3)), text: c.text })),
      captions: subs.map((s) => ({ start: Number(s.start.toFixed(3)), end: Number(s.end.toFixed(3)), text: s.text })),
    },
    null,
    2,
  ),
);
