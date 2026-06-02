// audiofix.js — 让录音可精确随机定位
// MediaRecorder 产出的 WebM/Ogg(Opus) 容器没有 Cues 索引、头部也不写时长，
// 浏览器对这类流设置 currentTime 到中间位置时会把 seek 钳制回 0
// （表现为「点击靠后文本却从头开始播放」）。
// 解决办法：用 Web Audio 解码后重编码为 WAV —— WAV 是逐采样可定位的，
// 时间戳跳转因此变得精确。仅用于 <audio> 播放，STT 仍使用原始 blob。

let _ctx = null;
function audioCtx() {
  if (!_ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    _ctx = new AC();
  }
  return _ctx;
}

// 仅对常见「不可精确 seek」的录音容器转码；mp3/wav/m4a 通常本身就可定位。
function needsFix(type) {
  return /webm|ogg|opus/i.test(type || '');
}

/**
 * 返回一个可精确 seek 的音频 Blob。
 * - WebM/Ogg → 解码并重编码为 WAV
 * - 其它格式或解码失败 → 原样返回
 */
export async function toSeekableBlob(blob) {
  if (!blob || !needsFix(blob.type)) return blob;
  try {
    const arrayBuf = await blob.arrayBuffer();
    // decodeAudioData 会消费 ArrayBuffer，传副本以防其它地方仍需原始数据
    const audioBuf = await audioCtx().decodeAudioData(arrayBuf.slice(0));
    return encodeWav(audioBuf);
  } catch (e) {
    console.warn('[audiofix] 解码失败，回退原始音频播放：', e);
    return blob;
  }
}

// 把 AudioBuffer 编码为 16-bit PCM WAV
function encodeWav(audioBuffer) {
  const numCh = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let o = 0;
  const wstr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(o++, s.charCodeAt(i)); };
  const u32 = (v) => { view.setUint32(o, v, true); o += 4; };
  const u16 = (v) => { view.setUint16(o, v, true); o += 2; };

  wstr('RIFF'); u32(36 + dataSize); wstr('WAVE');
  wstr('fmt '); u32(16); u16(1); u16(numCh); u32(sampleRate);
  u32(sampleRate * blockAlign); u16(blockAlign); u16(16);
  wstr('data'); u32(dataSize);

  // 交错写入各声道 PCM16
  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(audioBuffer.getChannelData(c));
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
