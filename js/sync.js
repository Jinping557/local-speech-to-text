// sync.js — 音文双向同步引擎
// Audio→Text: rAF 循环 + 二分查找当前词，<200ms 精度
// Text→Audio: 点击词 span 跳转音频

let _audio = null;
let _flat = [];
let _container = null;
let _rafId = 0;
let _currentIdx = -1;
let _onWordChange = null;

export function bind({ audio, flatWords, container, onWordChange }) {
  unbind();
  _audio = audio;
  _flat = flatWords || [];
  _container = container;
  _onWordChange = onWordChange || null;
  _currentIdx = -1;

  // 点击寻迹
  if (_container) {
    _container.addEventListener('click', _onClick);
  }
  // 拖动进度条立即刷新一次（避免 rAF 暂停时滞）
  if (_audio) {
    _audio.addEventListener('seeked', _force);
    _audio.addEventListener('seeking', _force);
    _audio.addEventListener('timeupdate', _force);  // 多一层兜底
  }

  start();
}

export function unbind() {
  stop();
  if (_container) _container.removeEventListener('click', _onClick);
  if (_audio) {
    _audio.removeEventListener('seeked', _force);
    _audio.removeEventListener('seeking', _force);
    _audio.removeEventListener('timeupdate', _force);
  }
  if (_currentIdx >= 0 && _flat[_currentIdx]?.el) {
    _flat[_currentIdx].el.classList.remove('active');
  }
  _audio = null; _flat = []; _container = null; _onWordChange = null; _currentIdx = -1;
}

export function start() {
  if (_rafId) return;
  const tick = () => {
    if (_audio) {
      _update(_audio.currentTime);
    }
    _rafId = requestAnimationFrame(tick);
  };
  _rafId = requestAnimationFrame(tick);
}

export function stop() {
  if (_rafId) cancelAnimationFrame(_rafId);
  _rafId = 0;
}

function _force() {
  if (_audio) _update(_audio.currentTime);
}

function _onClick(e) {
  // 编辑模式下不寻迹（避免点击修改文本时跳音频）
  if (_container?.getAttribute('contenteditable') === 'true') return;
  const w = e.target.closest('.w');
  if (!w || !_audio) return;
  const t = parseFloat(w.dataset.start);
  if (Number.isFinite(t)) {
    _audio.currentTime = t;
    _audio.play().catch(() => {});
  }
}

// 二分查找：第一个 end > t 的词，且 start <= t；若 t 落在 gap 中返回最近的下一个词
function _bsearch(words, t) {
  if (words.length === 0) return -1;
  if (t < words[0].start) return 0;
  if (t >= words[words.length - 1].end) return words.length - 1;
  let lo = 0, hi = words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].end <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function _update(t) {
  if (_flat.length === 0) return;
  const i = _bsearch(_flat, t);
  if (i === _currentIdx) return;
  if (_currentIdx >= 0 && _flat[_currentIdx]?.el) {
    _flat[_currentIdx].el.classList.remove('active');
  }
  if (i >= 0 && _flat[i]?.el) {
    _flat[i].el.classList.add('active');
    _ensureVisible(_flat[i].el);
  }
  _currentIdx = i;
  if (_onWordChange) _onWordChange(i, _flat[i]);
}

function _ensureVisible(el) {
  if (!el || !_container) return;
  const r = el.getBoundingClientRect();
  const c = _container.getBoundingClientRect();
  // 只在元素超出视口才滚（避免每词都滚导致抖动）
  if (r.top < c.top + 20 || r.bottom > c.bottom - 20) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// 调试：当前音频时间与高亮词时间偏差
export function debugDrift() {
  if (!_audio || _currentIdx < 0) return null;
  const w = _flat[_currentIdx];
  return { audioT: _audio.currentTime, wordStart: w.start, wordEnd: w.end,
           drift: Math.min(Math.abs(_audio.currentTime - w.start),
                           Math.abs(_audio.currentTime - w.end)) };
}
