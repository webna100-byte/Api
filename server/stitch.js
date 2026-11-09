// Join several short clips into one longer video with ffmpeg
// (free workaround when a provider caps duration below 15–20s).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OUTPUT_DIR, DATA_DIR } from './config.js';

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', (e) => reject(new Error(`ffmpeg not found: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `ffmpeg exit ${code}`))));
  });
}

/** @param {string[]} files  file names inside OUTPUT_DIR, in playback order */
export async function stitch(files) {
  if (files.length < 2) throw new Error('Pick at least 2 clips');
  const abs = files.map((f) => {
    const p = path.join(OUTPUT_DIR, path.basename(f));
    if (!fs.existsSync(p)) throw new Error(`Missing file: ${f}`);
    return p;
  });
  const list = path.join(DATA_DIR, `concat-${Date.now()}.txt`);
  fs.writeFileSync(list, abs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  const name = `stitched_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`;
  const out = path.join(OUTPUT_DIR, name);
  try {
    // Fast path: same codec/size (clips from one provider with the same settings).
    await ffmpeg(['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
  } catch {
    // Fallback: re-encode to the first clip's settings.
    await ffmpeg([
      '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
    ]);
  } finally {
    fs.rmSync(list, { force: true });
  }
  return name;
}
