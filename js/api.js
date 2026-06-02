// api.js — OpenAI 兼容协议客户端
// /audio/transcriptions → verbose_json + word timestamps

import { getActivePreset } from './storage.js';

export class ApiError extends Error {
  constructor(status, body, message) {
    super(message || `API ${status}`);
    this.status = status;
    this.body = body;
  }
}

function joinUrl(base, path) {
  if (!base) throw new ApiError(0, '', '未配置 Base URL');
  return base.replace(/\/+$/, '') + path;
}

/**
 * 调用 STT。返回归一化后的 Transcript 对象：
 *   { language, duration, segments: [{id,start,end,text,words:[{start,end,text}]}] }
 */
export async function transcribe(audioBlob, opts = {}) {
  // opts.config 可显式覆盖（用于「即填即测」，无需先保存预设）
  const cfg = opts.config || getActivePreset();
  if (!cfg.sttApiKey) throw new ApiError(0, '', '未配置 STT API Key');

  const fd = new FormData();
  const filename = opts.filename || `audio.${guessExt(audioBlob.type)}`;
  fd.append('file', audioBlob, filename);
  fd.append('model', cfg.sttModel);
  fd.append('response_format', 'verbose_json');
  // 多数厂商支持。失败的厂商会忽略此字段，回退为 segment 级。
  fd.append('timestamp_granularities[]', 'word');
  fd.append('timestamp_granularities[]', 'segment');
  if (opts.language) fd.append('language', opts.language);
  if (opts.prompt) fd.append('prompt', opts.prompt);

  const url = joinUrl(cfg.sttBaseUrl, '/audio/transcriptions');
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.sttApiKey}` },
      body: fd,
    });
  } catch (e) {
    throw new ApiError(0, String(e), '网络错误：' + e.message);
  }
  if (!res.ok) {
    const text = await safeText(res);
    throw new ApiError(res.status, text, friendlyError(res.status, text));
  }
  const json = await res.json();
  const elapsed = performance.now() - t0;
  return { ...normalize(json), _elapsedMs: elapsed, _model: cfg.sttModel };
}

/**
 * 把不同厂商的 verbose_json 归一化为统一形状。
 * 兼容情况：
 *   - 标准 OpenAI：{ language, duration, text, segments[], words[] (扁平) }
 *   - 某些厂商：words 嵌在 segments[].words
 *   - 部分厂商：仅返回 segments，无 words → 段内按字数线性插值
 */
export function normalize(raw) {
  const language = raw.language || 'zh';
  const duration = Number(raw.duration) || 0;
  const segments = Array.isArray(raw.segments) ? raw.segments : [];
  const flatWords = Array.isArray(raw.words) ? raw.words : null;

  // 把扁平 words 按时间归到对应 segment
  function findSegIdx(t) {
    for (let i = 0; i < segments.length; i++) {
      if (t >= (segments[i].start ?? 0) && t < (segments[i].end ?? Infinity)) return i;
    }
    return Math.max(0, segments.length - 1);
  }

  const out = {
    language,
    duration,
    segments: segments.map((s, i) => ({
      id: s.id ?? i,
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: (s.text || '').trim(),
      words: Array.isArray(s.words) ? s.words.map(normWord) : [],
    })),
  };

  if (flatWords && out.segments.length) {
    for (const w of flatWords) {
      const nw = normWord(w);
      const idx = findSegIdx(nw.start);
      out.segments[idx].words.push(nw);
    }
  }

  // 若厂商完全没给有效的段级时间（start/end 全为 0），词时间会塌缩到 ~0，
  // 导致点击任意文本都从头播放。这里按文本长度在总时长上分布，恢复可跳转性。
  ensureSegmentTiming(out, duration);

  // 逐段校验词时间：只要词时间缺失、全 0、或不随时间推进（厂商用了不同
  // 字段名、单位不符、或根本没返回 word 级），就用该段的有效起止时间按字数
  // 重建，确保点击任意词都能跳到正确位置，而不是一律跳回 0。
  for (const seg of out.segments) {
    if (seg.text && !wordsUsable(seg.words)) {
      seg.words = synthWordsFromText(seg.text, seg.start, seg.end);
    }
  }

  // 仍然没有 segments（极端厂商） → 用 text 兜底
  if (out.segments.length === 0 && raw.text) {
    out.segments = [{
      id: 0, start: 0, end: duration,
      text: String(raw.text).trim(),
      words: synthWordsFromText(String(raw.text).trim(), 0, duration || 1),
    }];
  }

  return out;
}

// 判断一段的 words 时间戳是否可用：存在、数值有效、且整体随时间推进
// （最大 end 严格大于最小 start）。全 0 或所有词同一时刻都视为不可用。
function wordsUsable(words) {
  if (!words || words.length === 0) return false;
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const w of words) {
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) return false;
    if (w.start < minStart) minStart = w.start;
    if (w.end > maxEnd) maxEnd = w.end;
  }
  return maxEnd > minStart;
}

// 当厂商未提供有效段级时间时，按各段文本长度在总时长上等比分布，
// 并重建词时间戳，确保「点击文本→跳转对应音频」可用。
function ensureSegmentTiming(out, duration) {
  const segs = out.segments;
  if (segs.length === 0) return;
  const hasTiming = segs.some((s) => s.end > 0 && s.end > s.start);
  if (hasTiming) return; // 厂商已给有效时间，不动

  const lens = segs.map((s) => Math.max(1, Array.from(s.text).length));
  const sum = lens.reduce((a, b) => a + b, 0) || 1;
  // 有总时长用之；否则按 ~5 字/秒粗估，至少保证相对顺序正确
  const total = duration > 0 ? duration : sum / 5;
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    const start = (total * acc) / sum;
    acc += lens[i];
    const end = (total * acc) / sum;
    segs[i].start = start;
    segs[i].end = end;
    segs[i].words = synthWordsFromText(segs[i].text, start, end);
  }
}

function normWord(w) {
  return {
    start: Number(w.start) || 0,
    end: Number(w.end) || 0,
    text: String(w.word ?? w.text ?? '').trim(),
  };
}

// 把段文本按字数等距切成"伪 word" 列表（仅当厂商不返回 word-level 时）
export function synthWordsFromText(text, start, end) {
  const chars = Array.from(text);
  if (chars.length === 0) return [];
  const total = Math.max(0.001, end - start);
  const step = total / chars.length;
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    out.push({
      start: start + i * step,
      end: start + (i + 1) * step,
      text: chars[i],
    });
  }
  return out;
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

function friendlyError(status, body) {
  if (status === 401) return 'API Key 无效或已过期 (401)';
  if (status === 403) return '无权访问该模型 (403)';
  if (status === 404) return '接口路径错误 (404)，请检查 Base URL';
  if (status === 413) return '音频文件过大 (413)';
  if (status === 429) return '请求过于频繁，稍后再试 (429)';
  if (status >= 500) return '服务端错误 (' + status + ')，请稍后重试';
  return `请求失败 (${status})${body ? ': ' + body.slice(0, 120) : ''}`;
}

function guessExt(mime) {
  if (!mime) return 'webm';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

// 连通性检查：用一段极短静音 wav 实际打一次 STT。
// 传入 cfg 可测试任意（未保存的）配置；缺省回退到当前 active 预设。
export async function pingConfig(cfg) {
  const target = cfg || getActivePreset();
  if (!target.sttApiKey) throw new ApiError(0, '', '未配置 API Key');
  if (!target.sttBaseUrl) throw new ApiError(0, '', '未配置 Base URL');
  // 构造一个极短的静音 wav 测试（200ms）
  const blob = makeSilenceWav(0.2);
  await transcribe(blob, { filename: 'ping.wav', config: target });
  return true;
}

// 向后兼容：测试当前 active 预设
export async function pingActive() {
  return pingConfig(getActivePreset());
}

// 对话/纠错模型连通性检查：发送一条极短消息。
// 未配置时返回 null（跳过，非错误）。
export async function pingChatConfig(cfg) {
  const target = cfg || getActivePreset();
  if (!target.chatApiKey || !target.chatBaseUrl || !target.chatModel) return null;
  const url = joinUrl(target.chatBaseUrl, '/chat/completions');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.chatApiKey}` },
      body: JSON.stringify({ model: target.chatModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
    });
  } catch (e) {
    throw new ApiError(0, String(e), '对话模型网络错误：' + e.message);
  }
  if (!res.ok) {
    const text = await safeText(res);
    throw new ApiError(res.status, text, '对话模型：' + friendlyError(res.status, text));
  }
  return true;
}

/**
 * 用对话/纠错模型对 STT 结果按 prompt 纠错。
 * 返回新的 transcript 对象（segment 文本已替换，word 时间戳等比重分布）。
 */
export async function chatCorrectTranscript(transcript, prompt, cfg) {
  const target = cfg || getActivePreset();
  if (!target.chatApiKey) throw new ApiError(0, '', '未配置对话模型 API Key');
  if (!target.chatBaseUrl) throw new ApiError(0, '', '未配置对话模型 Base URL');
  if (!target.chatModel) throw new ApiError(0, '', '未配置对话模型名称');

  const segTexts = transcript.segments.map((s, i) => `[${i}] ${s.text}`).join('\n');
  const systemMsg = '你是专业的语音转写校对助手。用户发来按编号排列的转写文本片段，请按用户要求逐段校对。' +
    '严格按原始格式返回：[编号] 校对后文本，每段占一行，不增减行数，不加任何解释。';
  const userMsg = `${prompt}\n\n待校对的转写文本：\n${segTexts}`;

  const url = joinUrl(target.chatBaseUrl, '/chat/completions');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.chatApiKey}` },
      body: JSON.stringify({
        model: target.chatModel,
        messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }],
        temperature: 0.2,
      }),
    });
  } catch (e) {
    throw new ApiError(0, String(e), '对话模型网络错误：' + e.message);
  }
  if (!res.ok) {
    const text = await safeText(res);
    throw new ApiError(res.status, text, '对话模型：' + friendlyError(res.status, text));
  }
  const json = await res.json();
  const correctedRaw = json.choices?.[0]?.message?.content || '';

  // 解析 [N] 文本 格式，缺失的 segment 保留原文
  const correctedTexts = transcript.segments.map((s) => s.text);
  for (const line of correctedRaw.split('\n')) {
    const m = line.match(/^\[(\d+)\]\s*(.*)/);
    if (m) {
      const idx = parseInt(m[1]);
      if (idx >= 0 && idx < correctedTexts.length) correctedTexts[idx] = m[2].trim();
    }
  }

  return {
    ...transcript,
    segments: transcript.segments.map((seg, i) => {
      const newText = correctedTexts[i];
      if (newText === seg.text) return seg;
      return { ...seg, text: newText, words: synthWordsFromText(newText, seg.start, seg.end) };
    }),
  };
}

function makeSilenceWav(seconds) {
  const sampleRate = 8000;
  const numSamples = Math.floor(sampleRate * seconds);
  const buf = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buf);
  // RIFF header
  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, numSamples * 2, true);
  return new Blob([buf], { type: 'audio/wav' });
}
function writeStr(view, off, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
}
