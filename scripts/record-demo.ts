/**
 * npm run demo:record   Records `npm run demo:video` into docs/video/:
 *   guard-demo.cast   asciicast v2 (play with `asciinema play`, or convert with `agg` to a GIF)
 *   transcript.txt    the same run as plain text (for subtitles and review)
 *   viewer.html       self-contained player: terminal on the left, the Telegram chat on a phone on the
 *                     right, scene captions on top. Open it, press Space, screen-record at 1920x1080.
 *                     ?scene=N jumps to the end of scene N; ?t=SECONDS jumps to a time; ?layout=terminal
 *                     shows the terminal only; ?clean=1 hides the controls.
 *
 * Flags: --pace <x> (default 2, about 2:20 for a narrated video), --viewer-only (rebuild viewer.html from the existing cast).
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/demo/setup";

const OUT = join(ROOT, "docs/video");
const CAST = join(OUT, "guard-demo.cast");
const WIDTH = 100;
const HEIGHT = 44;
/** Longest pause kept in the recording (node start-up and sandbox boot are compressed). */
const MAX_IDLE = 6;

const argv = process.argv.slice(2);
const paceIdx = argv.indexOf("--pace");
const pace = paceIdx >= 0 ? argv[paceIdx + 1]! : "2";
mkdirSync(OUT, { recursive: true });

if (!argv.includes("--viewer-only")) {
  const events: Array<[number, string]> = [];
  const start = performance.now();
  let last = 0;
  let shift = 0;
  const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "scripts/demo-video.ts"), "--osc", "--pace", pace], {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: "1", NO_COLOR: "", COLUMNS: String(WIDTH) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    let t = (performance.now() - start) / 1000 - shift;
    if (t - last > MAX_IDLE) {
      shift += t - last - MAX_IDLE;
      t = last + MAX_IDLE;
    }
    last = t;
    events.push([Number(t.toFixed(3)), chunk.replace(/\r?\n/g, "\r\n")]);
    process.stdout.write(".");
  });
  const code: number = await new Promise((r) => child.on("close", (c) => r(c ?? 1)));
  process.stdout.write("\n");
  if (code !== 0) throw new Error(`demo:video exited with ${code}`);
  const header = { version: 2, width: WIDTH, height: HEIGHT, title: "Guard: policy firewall for AI-agent wallets on NEAR (NEAR HACKATHON 2026)", env: { TERM: "xterm-256color", SHELL: "/bin/zsh" } };
  writeFileSync(CAST, [JSON.stringify(header), ...events.map(([t, d]) => JSON.stringify([t, "o", d]))].join("\n") + "\n");
  const plain = events
    .map(([, d]) => d)
    .join("")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r\n/g, "\n");
  writeFileSync(join(OUT, "transcript.txt"), plain);
  console.log(`wrote ${CAST} (${last.toFixed(1)} s, ${events.length} events) and transcript.txt`);
}

const cast = readFileSync(CAST, "utf8");
const template = readFileSync(join(ROOT, "scripts/viewer-template.html"), "utf8");
writeFileSync(join(OUT, "viewer.html"), template.replace("/*CAST_JSON*/null", JSON.stringify(cast).replace(/<\//g, "<\\/")));
console.log(`wrote ${join(OUT, "viewer.html")}`);
