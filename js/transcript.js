// transcript.js — 把归一化的 Transcript 渲染为可点击/可同步的 word-span DOM
// 暴露：render(transcript, container) → { flatWords }，以及 getCurrentText() 等工具

let _state = {
  transcript: null,
  flatWords: [],     // [{ start, end, text, el, segIdx, idxInSeg }]
};

export function render(transcript, container) {
  container.innerHTML = '';
  _state.transcript = transcript;
  _state.flatWords = [];

  if (!transcript || !transcript.segments || transcript.segments.length === 0) {
    container.innerHTML = '<div class="placeholder">（无内容）</div>';
    return _state;
  }

  let globalIdx = 0;
  for (let s = 0; s < transcript.segments.length; s++) {
    const seg = transcript.segments[s];
    const p = document.createElement('p');
    p.className = 'seg';
    p.dataset.seg = String(s);

    const meta = document.createElement('span');
    meta.className = 'seg-meta';
    meta.textContent = formatTime(seg.start);
    p.appendChild(meta);

    const words = seg.words && seg.words.length ? seg.words : [{ start: seg.start, end: seg.end, text: seg.text }];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const span = document.createElement('span');
      span.className = 'w';
      span.dataset.start = String(w.start);
      span.dataset.end = String(w.end);
      span.dataset.idx = String(globalIdx);
      span.dataset.seg = String(s);
      if (w._evolved) span.classList.add('evolved');
      span.textContent = w.text;
      p.appendChild(span);
      _state.flatWords.push({
        start: w.start,
        end: w.end,
        text: w.text,
        el: span,
        segIdx: s,
        idxInSeg: i,
      });
      globalIdx++;
    }
    container.appendChild(p);
  }
  return _state;
}

export function getState() { return _state; }
export function getFlatWords() { return _state.flatWords; }
export function getTranscript() { return _state.transcript; }

export function formatTime(sec) {
  if (!Number.isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${pad(m)}:${pad(s)}`;
}
function pad(n) { return n < 10 ? '0' + n : '' + n; }

// 在转写文本中重新构建 segments[].text，便于编辑模式回写
export function rebuildSegmentTextFromWords(transcript) {
  for (const seg of transcript.segments) {
    seg.text = seg.words.map((w) => w.text).join('');
  }
}
