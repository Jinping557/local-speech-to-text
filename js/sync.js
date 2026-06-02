// sync.js — 音文双向同步引擎
// Audio→Text: rAF 循环 + 二分查找当前词，<200ms 精度
// Text→Audio: 点击词 span 跳转音频

let _audio = null;
let _flat = [];
let _container = null;
let _rafId = 0;
let _currentIdx = -1;
let _onWordChange = null;
let _pendingSeek = null;
let _durationListener = null;

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
    if (_durationListener) {
      _audio.removeEventListener('durationchange', _durationListener);
    }
  }
  if (_currentIdx >= 0 && _flat[_currentIdx]?.el) {
    _flat[_currentIdx].el.classList.remove('active');
  }
  _audio = null; _flat = []; _container = null; _onWordChange = null; _currentIdx = -1;
  _pendingSeek = null; _durationListener = null;
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

function _seekTo(t) {
  if (!_audio) return;
  const target = Math.max(0, t);
  const dur = _audio.duration;
  if (Number.isFinite(dur) && dur > 0) {
    _applySeek(Math.min(target, Math.max(0, dur - 0.05)));
    return;
  }
  // duration 尚未解析（WebM/MediaRecorder 的 Infinity 情形）：
  // 记录目标时间，注册 durationchange 等待真实时长解析后再跳转。
  _pendingSeek = target;
  if (_durationListener) return; // 已在等待，更新 _pendingSeek 即可
  _durationListener = () => {
    const d = _audio.duration;
    if (!Number.isFinite(d) || d <= 0) return; // 还没解析好，继续等
    _audio.removeEventListener('durationchange', _durationListener);
    _durationListener = null;
    if (_pendingSeek !== null) {
      const tg = _pendingSeek;
      _pendingSeek = null;
      _applySeek(Math.min(tg, Math.max(0, d - 0.05)));
    }
  };
  _audio.addEventListener('durationchange', _durationListener);
  // 触发浏览器扫描文件末尾以得到真实时长
  try { _audio.currentTime = 1e7; } catch { /* ignore */ }
}

// 设置 currentTime 并播放；校验 seek 是否真正落点（诊断不可定位的音频）。
function _applySeek(target) {
  const onSeeked = () => {
    _audio.removeEventListener('seeked', onSeeked);
    if (target > 0.5 && _audio.currentTime < 0.3) {
      console.warn(
        `[sync] seek 被钳制回 ${_audio.currentTime.toFixed(2)}s（目标 ${target.toFixed(2)}s）：` +
        '该音频不可随机定位，应已转码为 WAV，请检查 audiofix 是否生效。'
      );
    }
  };
  _audio.addEventListener('seeked', onSeeked, { once: true });
  try {
    _audio.currentTime = target;
  } catch (e) {
    console.warn('[sync] 设置 currentTime 失败：', e);
  }
  _audio.play().catch(() => {});
}

function _onClick(e) {
  // 编辑模式下不寻迹（避免点击修改文本时跳音频）
  if (_container?.getAttribute('contenteditable') === 'true') return;
  const w = e.target.closest('.w');
  if (!w || !_audio) return;
  const t = parseFloat(w.dataset.start);
  if (Number.isFinite(t)) _seekTo(t);
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
