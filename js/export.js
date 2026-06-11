// export.js — 导出 Markdown
import { formatTime } from './transcript.js?v=2026-06-11-2';

export function buildMarkdown(transcript, meta = {}) {
  const lines = [];
  const title = meta.title || '口述历史·' + new Date().toLocaleString('zh-CN');
  lines.push(`# ${title}`, '');
  lines.push(`- 时长：${formatTime(transcript.duration || 0)}`);
  if (meta.model) lines.push(`- 转写模型：${meta.model}`);
  if (typeof meta.dictHits === 'number') lines.push(`- 进化字典命中：${meta.dictHits} 处`);
  if (meta.sourceName) lines.push(`- 来源：${meta.sourceName}`);
  lines.push(`- 导出时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push('', '---', '');

  for (const seg of transcript.segments) {
    const text = (seg.words && seg.words.length)
      ? seg.words.map((w) => w.text).join('')
      : (seg.text || '');
    if (!text.trim()) continue;
    lines.push(`[${formatTime(seg.start)}] ${text.trim()}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function downloadMarkdown(transcript, meta = {}) {
  const md = buildMarkdown(transcript, meta);
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = makeFilename(meta.sourceName);
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

// 一键复制 Markdown 到剪贴板。优先 Clipboard API（需 HTTPS/localhost），
// 失败时回退到隐藏 textarea + execCommand。
export async function copyMarkdown(transcript, meta = {}) {
  const md = buildMarkdown(transcript, meta);
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(md);
      return true;
    } catch { /* 失败则走回退方案 */ }
  }
  const ta = document.createElement('textarea');
  ta.value = md;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function makeFilename(sourceName) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const stem = sourceName ? sourceName.replace(/\.[^.]+$/, '') : `${y}${m}${day}_${hh}${mm}`;
  return `黔音留痕_${stem}.md`;
}
