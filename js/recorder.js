// recorder.js — MediaRecorder 包装
// 用法：const rec = new Recorder(); await rec.start(); ... const blob = await rec.stop();

export class Recorder {
  constructor() {
    this._mr = null;
    this._stream = null;
    this._chunks = [];
    this._mime = '';
    this._startedAt = 0;
  }

  static isSupported() {
    return typeof navigator !== 'undefined'
      && navigator.mediaDevices?.getUserMedia
      && typeof MediaRecorder !== 'undefined';
  }

  async start() {
    if (this._mr) throw new Error('已经在录音');
    if (!Recorder.isSupported()) throw new Error('浏览器不支持录音 (MediaRecorder)');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 48000,
      },
    });
    this._stream = stream;

    // 选择浏览器支持的 mime
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      '',
    ];
    let mime = '';
    for (const c of candidates) {
      if (c === '' || MediaRecorder.isTypeSupported(c)) { mime = c; break; }
    }
    this._mime = mime || 'audio/webm';

    const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    this._mr = mr;
    this._chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) this._chunks.push(e.data); };
    mr.start(250);  // 每 250ms 一块
    this._startedAt = performance.now();
  }

  isRecording() {
    return Boolean(this._mr && this._mr.state === 'recording');
  }

  elapsedSec() {
    if (!this._startedAt) return 0;
    return (performance.now() - this._startedAt) / 1000;
  }

  async stop() {
    if (!this._mr) return null;
    const mr = this._mr;
    const stream = this._stream;
    const mime = this._mime;
    const chunks = this._chunks;
    this._mr = null; this._stream = null; this._chunks = []; this._startedAt = 0;

    return new Promise((resolve) => {
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(chunks, { type: mime || 'audio/webm' }));
      };
      mr.stop();
    });
  }

  cancel() {
    if (!this._mr) return;
    try { this._mr.stop(); } catch {}
    if (this._stream) this._stream.getTracks().forEach((t) => t.stop());
    this._mr = null; this._stream = null; this._chunks = []; this._startedAt = 0;
  }
}
