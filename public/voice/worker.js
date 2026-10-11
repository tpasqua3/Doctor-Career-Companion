/* The offline voice. Runs the Kokoro voice model on this device, off the page's main thread, so the app stays responsive while a
   passage is being turned into speech. The page (app/companion.html, "kok") sends:
     { load: { dtype: 'q8' | 'fp32', device: 'wasm' | 'webgpu' } }   download (first time) and start the model
     { say: { id, text, voice } }                                     speak one passage
   and gets back { progress }, { ready, voices } , { clip: { id, wav } } or { error, id }. */
import { KokoroTTS } from './kokoro.web.js';
let tts = null;
function wav(samples, rate) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2)), str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return out.buffer;
}
let chain = Promise.resolve();
self.onmessage = e => { const m = e.data || {};
  chain = chain.then(async () => {
    if (m.load) {
      const seen = {};
      tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: m.load.dtype, device: m.load.device,
        progress_callback: p => { if (p && p.status === 'progress' && p.total) { seen[p.file] = [p.loaded, p.total]; let a = 0, b = 0; for (const k in seen) { a += seen[k][0]; b += seen[k][1]; } self.postMessage({ progress: { loaded: a, total: b } }); } } });
      const v = tts.voices; self.postMessage({ ready: true, voices: Object.keys(v).map(id => ({ id, name: v[id].name, accent: id[0] === 'b' ? 'British' : 'American', gender: v[id].gender, grade: v[id].overallGrade })) });
    } else if (m.say) {
      if (!tts) throw new Error('not loaded');
      const a = await tts.generate(m.say.text, { voice: m.say.voice || 'af_heart', speed: 1 }), buf = wav(a.audio, a.sampling_rate);
      self.postMessage({ clip: { id: m.say.id, wav: buf } }, [buf]);
    }
  }).catch(err => self.postMessage({ error: String(err && err.message || err).slice(0, 300), id: m.say ? m.say.id : undefined, load: !!m.load }));
};
