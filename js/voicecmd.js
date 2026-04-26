// voicecmd.js — 语音指令解析："把X改为Y" / "把X改成Y"

const RX = /把(.+?)改(?:为|成)(.+)/;

/**
 * 把识别结果文本解析为指令对象 { from, to } 或 null
 */
export function parseCommand(text) {
  if (!text) return null;
  // 去空白与中文标点（保留汉字与字母数字）
  const cleaned = String(text)
    .replace(/[\s,，。！!？?；;：:、""''「」『』《》()（）]/g, '')
    .trim();
  const m = cleaned.match(RX);
  if (!m) return null;
  const from = m[1].trim();
  const to = m[2].trim();
  if (!from || !to || from === to) return null;
  return { from, to };
}
