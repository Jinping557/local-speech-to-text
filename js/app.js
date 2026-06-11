// app.js — 入口与编排
import * as Storage from './storage.js?v=2026-06-11-1';
import { transcribe, chatCorrectTranscript, synthWordsFromText, textWeight, pingConfig, pingChatConfig, ApiError } from './api.js?v=2026-06-11-1';
import { Recorder } from './recorder.js?v=2026-06-11-1';
import { render as renderTranscript, getTranscript, getFlatWords, formatTime } from './transcript.js?v=2026-06-11-1';
import * as Sync from './sync.js?v=2026-06-11-1';
import * as Evolution from './evolution.js?v=2026-06-11-1';
import { parseCommand } from './voicecmd.js?v=2026-06-11-1';
import { downloadMarkdown, copyMarkdown } from './export.js?v=2026-06-11-1';
import { GUIZHOU_DIALECT_PRESET } from './dialect.js?v=2026-06-11-1';
import { toSeekableBlob } from './audiofix.js?v=2026-06-11-1';

// 前端构建版本：发布时手动 +1，并与 index.html 的 ?v= 查询串保持一致。
// 显示在底部状态栏，用于确认线上是否已是最新代码。
const BUILD = '2026-06-11-1';

// === 转写提示词预设（用于对话/纠错模型的后处理指令）===
const PROMPT_PRESETS = [
  { id: 'guizhou', label: '方言：贵州话', text: '以下为贵州方言转写，请按方言习惯纠错（近音字、方言词汇等）。' },
  { id: 'clean',   label: '清理语气词',   text: '请删除无意义的重复语气词，例如「嗯」「哦」「呃」「啊」等。' },
  { id: 'names',   label: '保留人名地名', text: '请保留转写中出现的人名和地名，不要简化或省略。' },
  { id: 'english', label: '保留英文原词', text: '涉及英文单词时，请保留原始英文拼写，不要翻译或音译。' },
  { id: 'fluency', label: '语义通顺',     text: '请根据上下语境，保持转写结果语义通顺，纠正明显的识别错误。' },
];

// === 应用状态 ===
const state = {
  audioBlob: null,
  audioName: '',
  transcript: null,         // 当前归一化后的转写
  originalSegmentTexts: [], // 渲染前快照，用于 diff 提取规则
  editing: false,
  recording: false,
  voiceCmdRecording: false,
};

// === DOM ===
const $ = (id) => document.getElementById(id);
const els = {
  audio: $('audio'),
  audioMeta: $('audio-meta'),
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  recToggle: $('rec-toggle'),
  recStatus: $('rec-status'),
  voiceCmd: $('voice-cmd'),
  editToggle: $('edit-toggle'),
  retranscribe: $('retranscribe'),
  transcript: $('transcript'),
  presetSelect: $('preset-select'),
  openSettings: $('open-settings'),
  closeSettings: $('close-settings'),
  settingsMask: $('settings-mask'),
  addPresetSelect: $('add-preset-select'),
  detailEmpty: $('detail-empty'),
  detailPanel: $('detail-panel'),
  detailLogo: $('detail-logo'),
  detailName: $('detail-name'),
  detailSub: $('detail-sub'),
  detailActivePill: $('detail-active-pill'),
  detailActivate: $('detail-activate'),
  detailDelete: $('detail-delete'),
  cfgSttTemplate: $('cfg-stt-template'),
  cfgChatProvider: $('cfg-chat-provider'),
  cfgName: $('cfg-name'),
  cfgSttBase: $('cfg-stt-base'),
  cfgSttKey: $('cfg-stt-key'),
  cfgSttModel: $('cfg-stt-model'),
  cfgSttEye: $('cfg-stt-eye'),
  cfgSttTest: $('cfg-stt-test'),
  cfgChatBase: $('cfg-chat-base'),
  cfgChatKey: $('cfg-chat-key'),
  cfgChatModel: $('cfg-chat-model'),
  cfgChatEye: $('cfg-chat-eye'),
  cfgChatTest: $('cfg-chat-test'),
  presetList: $('preset-list'),
  promptPresets: $('prompt-presets'),
  promptText: $('prompt-text'),
  promptChatHint: $('prompt-chat-hint'),
  importDialect: $('import-dialect'),
  dictCount: $('dict-count'),
  dictHits: $('dict-hits'),
  rulePattern: $('rule-pattern'),
  ruleReplacement: $('rule-replacement'),
  ruleAddBtn: $('rule-add-btn'),
  ruleList: $('rule-list'),
  ruleListCount: $('rule-list-count'),
  copyMd: $('copy-md'),
  exportMd: $('export-md'),
  statusApi: $('status-api'),
  statusTask: $('status-task'),
  buildStamp: $('build-stamp'),
  toasts: $('toasts'),
};

const recorder = new Recorder();
const voiceRecorder = new Recorder();

// === Toast ===
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  els.toasts.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// === Status bar ===
function setApiStatus() {
  const ok = Storage.isApiConfigured();
  const p = Storage.getActivePreset();
  if (ok) {
    els.statusApi.textContent = `● ${p.name} · ${p.sttModel}`;
    els.statusApi.className = 'status-item ok';
  } else {
    els.statusApi.textContent = '● 未配置 API';
    els.statusApi.className = 'status-item warn';
  }
}
function setTaskStatus(text, kind = '') {
  els.statusTask.textContent = text;
  els.statusTask.className = 'status-item' + (kind ? ' ' + kind : '');
}

// === AI 模型配置（master–detail 弹窗，布局参考 next-ai-draw-io）===
// 左侧为预设列表，右侧为所选预设的配置卡片；所有改动即时写入 localStorage，
// 不再有「保存为预设」按钮。
let _selectedPresetIdx = 0;

function openSettings() {
  els.settingsMask.removeAttribute('inert');
  els.settingsMask.classList.remove('hidden');
  _selectedPresetIdx = Storage.getApiConfig().activePreset;
  renderSettings();
}
function closeSettings() {
  // 先移走焦点再隐藏，避免 inert/aria-hidden 抱住带焦点的元素（控制台告警）
  const focused = document.activeElement;
  if (focused && els.settingsMask.contains(focused)) focused.blur();
  els.settingsMask.classList.add('hidden');
  els.settingsMask.setAttribute('inert', '');
}

function renderSettings() {
  renderPresetSidebar();
  renderPresetDetail();
}

function presetInitial(p) {
  return (String(p?.name || '').trim()[0] || '基').toUpperCase();
}

// 左侧预设列表
function renderPresetSidebar() {
  const cfg = Storage.getApiConfig();
  els.presetList.innerHTML = '';
  cfg.presets.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'provider-item' + (i === _selectedPresetIdx ? ' selected' : '');
    li.innerHTML = `
      <span class="provider-tile">${escapeHtml(presetInitial(p))}</span>
      <span class="provider-item-info">
        <span class="provider-item-name">${escapeHtml(p.name || '未命名预设')}</span>
        <span class="provider-item-meta">${escapeHtml(p.sttModel || '未设模型')}</span>
      </span>
      <span class="provider-item-state">${i === cfg.activePreset ? '<span class="check">✓</span>' : '<span class="chev">›</span>'}</span>
    `;
    li.onclick = () => { _selectedPresetIdx = i; renderSettings(); };
    els.presetList.appendChild(li);
  });
}

// 右侧详情面板
function renderPresetDetail() {
  const cfg = Storage.getApiConfig();
  const p = cfg.presets[_selectedPresetIdx];
  const has = !!p;
  els.detailEmpty.classList.toggle('hidden', has);
  els.detailPanel.classList.toggle('hidden', !has);
  if (!has) return;
  updateDetailHeader(p, cfg);
  els.cfgName.value = p.name || '';
  els.cfgSttBase.value = p.sttBaseUrl || '';
  els.cfgSttKey.value = p.sttApiKey || '';
  els.cfgSttModel.value = p.sttModel || '';
  els.cfgChatBase.value = p.chatBaseUrl || '';
  els.cfgChatKey.value = p.chatApiKey || '';
  els.cfgChatModel.value = p.chatModel || '';
  // 切换预设时复位密码可见性与模板下拉
  resetEye(els.cfgSttKey, els.cfgSttEye);
  resetEye(els.cfgChatKey, els.cfgChatEye);
  els.cfgSttTemplate.value = '';
  els.cfgChatProvider.value = '';
}

function updateDetailHeader(p, cfg) {
  els.detailLogo.textContent = presetInitial(p);
  els.detailName.textContent = p.name || '未命名预设';
  els.detailSub.textContent = `${p.sttModel || '未设模型'} · ${p.sttBaseUrl || '未设 Base URL'}`;
  const isActive = _selectedPresetIdx === cfg.activePreset;
  els.detailActivePill.classList.toggle('hidden', !isActive);
  els.detailActivate.classList.toggle('hidden', isActive);
}

// 字段改动即时保存到所选预设（无保存按钮）
function saveDetailField(patch) {
  Storage.upsertPreset(patch, _selectedPresetIdx);
  const cfg = Storage.getApiConfig();
  updateDetailHeader(cfg.presets[_selectedPresetIdx], cfg);
  renderPresetSidebar();
  refreshPresetSelect();
  setApiStatus();
  updatePromptHint();
}

// 模板下拉：选厂商自动填 Base URL 与默认模型（不动 API Key）
function populateTemplateSelects() {
  Storage.PROVIDER_PRESETS.filter((t) => t.id !== 'custom').forEach((tpl) => {
    const opt = document.createElement('option');
    opt.value = tpl.id;
    opt.textContent = tpl.name;
    els.cfgSttTemplate.appendChild(opt);
  });
  Storage.CHAT_PROVIDER_PRESETS.filter((t) => t.id !== 'custom').forEach((tpl) => {
    const opt = document.createElement('option');
    opt.value = tpl.id;
    opt.textContent = tpl.name;
    els.cfgChatProvider.appendChild(opt);
  });
  // 侧栏底部「＋ 添加预设」：列出全部厂商模板
  Storage.PROVIDER_PRESETS.forEach((tpl) => {
    const opt = document.createElement('option');
    opt.value = tpl.id;
    opt.textContent = tpl.id === 'custom' ? '自定义（空白预设）' : tpl.name;
    els.addPresetSelect.appendChild(opt);
  });
}

function resetEye(input, btn) {
  input.type = 'password';
  btn.textContent = '👁';
}
function bindEye(input, btn) {
  btn.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? '🙈' : '👁';
  };
}

// 测试按钮：原位反馈（测试中… → ✓ 可用 / 复位）
async function runTest(btn, fn) {
  const original = '测试';
  btn.disabled = true;
  btn.textContent = '测试中…';
  try {
    await fn();
    btn.textContent = '✓ 可用';
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
    return true;
  } catch (e) {
    btn.textContent = original;
    btn.disabled = false;
    throw e;
  }
}

function isChatModelConfigured() {
  const p = Storage.getActivePreset();
  return !!(p.chatBaseUrl && p.chatApiKey && p.chatModel);
}
function updatePromptHint() {
  if (!els.promptChatHint) return;
  const hasPrompt = (els.promptText?.value || '').trim() !== '';
  els.promptChatHint.classList.toggle('hidden', !hasPrompt || isChatModelConfigured());
}


// === 顶栏基座下拉 ===
function refreshPresetSelect() {
  const cfg = Storage.getApiConfig();
  els.presetSelect.innerHTML = '';
  cfg.presets.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = p.name + ' · ' + p.sttModel;
    if (i === cfg.activePreset) opt.selected = true;
    els.presetSelect.appendChild(opt);
  });
}

// === 进化中心 ===
let _editingRuleId = null;

function refreshDictPanel() {
  const dict = Storage.getDict();
  els.dictCount.textContent = String(dict.length);
  els.dictHits.textContent = String(Evolution.getSessionHits());
  if (els.ruleListCount) els.ruleListCount.textContent = String(dict.length);
  els.ruleList.innerHTML = '';
  if (dict.length === 0) {
    _editingRuleId = null;
    els.ruleList.innerHTML = '<li class="empty">尚未学习。修改文本或使用 🎙 语音指令即可。</li>';
    return;
  }
  // 倒序，新加入靠前
  [...dict].reverse().forEach((r) => {
    const li = document.createElement('li');
    if (r.id === _editingRuleId) {
      renderRuleEditing(li, r);
    } else {
      renderRuleView(li, r);
    }
    els.ruleList.appendChild(li);
  });
}

function renderRuleView(li, r) {
  li.classList.remove('editing');
  li.innerHTML = `
    <span class="rule-text"><del>${escapeHtml(r.pattern)}</del> → <ins>${escapeHtml(r.replacement)}</ins></span>
    <span class="rule-meta" title="来源：${r.source} · 命中：${r.hits}">${r.source[0].toUpperCase()} ·${r.hits}</span>
    <button class="rule-edit" title="编辑">✎</button>
    <button class="rule-del" title="删除">✕</button>
  `;
  li.querySelector('.rule-edit').onclick = () => {
    _editingRuleId = r.id;
    refreshDictPanel();
  };
  li.querySelector('.rule-del').onclick = () => {
    if (!confirm(`删除词条「${r.pattern} → ${r.replacement}」？`)) return;
    Storage.deleteRule(r.id);
    if (_editingRuleId === r.id) _editingRuleId = null;
    refreshDictPanel();
  };
}

function renderRuleEditing(li, r) {
  li.classList.add('editing');
  li.innerHTML = `
    <input class="rule-edit-pattern" type="text" value="${escapeHtml(r.pattern)}" placeholder="原始" />
    <span class="arrow">→</span>
    <input class="rule-edit-replacement" type="text" value="${escapeHtml(r.replacement)}" placeholder="正确" />
    <button class="rule-save btn btn-primary">保存</button>
    <button class="rule-cancel btn btn-ghost">取消</button>
  `;
  const pIn = li.querySelector('.rule-edit-pattern');
  const rIn = li.querySelector('.rule-edit-replacement');
  pIn.focus();
  pIn.select();

  const save = () => {
    const pattern = pIn.value.trim();
    const replacement = rIn.value.trim();
    if (!pattern || !replacement) { toast('原始与正确表达均需填写', 'warn'); return; }
    if (pattern === replacement) { toast('两侧内容相同，无需保存', 'warn'); return; }
    const result = Storage.updateRule(r.id, { pattern, replacement });
    if (!result) { toast('更新失败', 'err'); return; }
    if (result.error === 'duplicate') {
      toast('已存在相同的"原始"词条，不能重复', 'warn');
      return;
    }
    _editingRuleId = null;
    // 立即对当前转写应用一次
    if (state.transcript) {
      const hits = Evolution.applyDict(state.transcript);
      renderAll();
      toast(`已更新：${pattern} → ${replacement}（命中 ${hits}）`, 'ok');
    } else {
      refreshDictPanel();
      toast(`已更新：${pattern} → ${replacement}`, 'ok');
    }
  };
  const cancel = () => { _editingRuleId = null; refreshDictPanel(); };

  li.querySelector('.rule-save').onclick = save;
  li.querySelector('.rule-cancel').onclick = cancel;
  [pIn, rIn].forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
  });
}

// === 转写提示词 ===
function _syncCheckboxes() {
  const lines = els.promptText.value.split('\n').map((l) => l.trim()).filter(Boolean);
  PROMPT_PRESETS.forEach((p) => {
    const cb = document.getElementById('prompt-cb-' + p.id);
    if (cb) cb.checked = lines.includes(p.text.trim());
  });
}

function _onPresetChange(preset, checked) {
  const lines = els.promptText.value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (checked) {
    if (!lines.includes(preset.text.trim())) lines.push(preset.text.trim());
  } else {
    const idx = lines.indexOf(preset.text.trim());
    if (idx >= 0) lines.splice(idx, 1);
  }
  els.promptText.value = lines.join('\n');
  Storage.setSttPrompt(els.promptText.value);
  _syncCheckboxes();
}

function initPromptUI() {
  PROMPT_PRESETS.forEach((p) => {
    const lbl = document.createElement('label');
    lbl.className = 'prompt-cb-item';
    lbl.htmlFor = 'prompt-cb-' + p.id;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'prompt-cb-' + p.id;
    cb.addEventListener('change', () => _onPresetChange(p, cb.checked));
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(p.label));
    els.promptPresets.appendChild(lbl);
  });
  els.promptText.value = Storage.getSttPrompt();
  _syncCheckboxes();
}

// 返回当前生效的提示词（空串表示无）
function getCurrentPrompt() {
  return els.promptText.value.trim();
}

// === 转写主流程 ===
async function doTranscribe(blob, sourceName) {
  if (!Storage.isApiConfigured()) {
    toast('请先在 ⚙ 设置中配置 API Key', 'warn');
    openSettings();
    return;
  }
  setTaskStatus('转写中…', 'warn');
  try {
    const t0 = performance.now();
    // prompt 不再发给 STT，仅用于后续对话模型纠错
    const tr = await transcribe(blob, { filename: sourceName || 'audio' });
    const sttElapsed = ((performance.now() - t0) / 1000).toFixed(1);

    let finalTr = tr;
    const prompt = getCurrentPrompt();
    if (prompt) {
      const p = Storage.getActivePreset();
      if (p.chatBaseUrl && p.chatApiKey && p.chatModel) {
        setTaskStatus(`STT ${sttElapsed}s · 纠错中…`, 'warn');
        try {
          finalTr = await chatCorrectTranscript(tr, prompt, p);
        } catch (ce) {
          console.error('chat correction failed:', ce);
          toast('对话模型纠错失败，显示原始转写：' + ce.message, 'warn');
          finalTr = tr;
        }
      } else {
        toast('转写提示词需要配置对话/纠错模型才能生效（设置 → 展开「对话/纠错模型」）', 'warn');
      }
    }

    const totalElapsed = ((performance.now() - t0) / 1000).toFixed(1);
    // 字典拦截
    const hits = Evolution.applyDict(finalTr);
    state.transcript = finalTr;
    state.originalSegmentTexts = finalTr.segments.map((s) => s.text);
    renderAll();
    const corrected = prompt && isChatModelConfigured();
    setTaskStatus(`转写${corrected ? '+纠错' : ''}完成 ${totalElapsed}s · 字典命中 ${hits}`, 'ok');
    if (hits > 0) toast(`进化字典已生效：${hits} 处自动修正`, 'ok');
  } catch (e) {
    console.error(e);
    setTaskStatus('转写失败', 'err');
    if (e instanceof ApiError) toast(e.message, 'err');
    else toast('转写失败：' + e.message, 'err');
  }
}

function renderAll() {
  if (!state.transcript) return;
  reconcileTimingWithAudio();
  renderTranscript(state.transcript, els.transcript);
  Sync.bind({
    audio: els.audio,
    flatWords: getFlatWords(),
    container: els.transcript,
    // 点击词跳转时给出可见反馈：显示真正跳到的时间，便于核对时间戳是否塌缩
    onSeek: (t) => toast('▶ 跳转到 ' + formatTime(t)),
  });
  refreshDictPanel();
  logTimingDiagnostics();
  // 渲染时若音频时长尚未解析，待其就绪后再重建一次时间线
  if (!Number.isFinite(els.audio.duration) || els.audio.duration <= 0) {
    els.audio.addEventListener('durationchange', _reReconcileOnce, { once: true });
  }
}

function _reReconcileOnce() {
  if (state.transcript && !state.editing) renderAll();
}

// 安全网：用真实音频时长校准转写时间线。
// 情况一：时间线整体超出音频时长（厂商按毫秒返回、单位不符等）→ 全量等比缩放，
//         保留词间相对位置，比线性重建精确得多。
// 情况二：时间线远短于真实音频（不足 10% 且 <1.5s，时长缺失/塌缩）→ 按各段
//         发音权重重建时间戳。
// 其余情况（如末尾静音导致 maxEnd 略小于音频时长）视为正常，不动。
function reconcileTimingWithAudio() {
  const tr = state.transcript;
  const audioDur = els.audio.duration;
  if (!tr || !Number.isFinite(audioDur) || audioDur <= 0) return false;
  const segs = tr.segments;
  if (!segs || segs.length === 0) return false;
  let maxEnd = 0;
  for (const s of segs) {
    if (Number.isFinite(s.end)) maxEnd = Math.max(maxEnd, s.end);
    for (const w of (s.words || [])) if (Number.isFinite(w.end)) maxEnd = Math.max(maxEnd, w.end);
  }
  if (maxEnd > audioDur * 1.05) {
    const k = audioDur / maxEnd;
    for (const s of segs) {
      s.start *= k; s.end *= k;
      for (const w of (s.words || [])) { w.start *= k; w.end *= k; }
    }
    tr.duration = audioDur;
    console.info(`[sync] 转写时间线(${maxEnd.toFixed(1)}s)超出音频(${audioDur.toFixed(1)}s)，已等比缩放对齐`);
    return true;
  }
  if (maxEnd > audioDur * 0.1 && maxEnd > 1.5) return false; // 时间线正常，不动
  const lens = segs.map((s) => textWeight(s.text));
  const sum = lens.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    const start = (audioDur * acc) / sum;
    acc += lens[i];
    const end = (audioDur * acc) / sum;
    segs[i].start = start;
    segs[i].end = end;
    segs[i].words = synthWordsFromText(segs[i].text, start, end);
  }
  tr.duration = audioDur;
  console.info(`[sync] 转写时间线(${maxEnd.toFixed(1)}s)远短于音频(${audioDur.toFixed(1)}s)，已按真实时长重建时间戳`);
  return true;
}

function logTimingDiagnostics() {
  const words = getFlatWords();
  if (!words.length) return;
  const sample = words.slice(0, 8).map((w) => +Number(w.start).toFixed(2));
  const last = words[words.length - 1];
  const dur = Number.isFinite(els.audio.duration) ? els.audio.duration.toFixed(2) : '未知';
  console.debug(`[sync] 词数=${words.length} 首词起点样例=${JSON.stringify(sample)} ` +
    `末词终点=${Number(last.end).toFixed(2)}s 音频时长=${dur}s`);
}

// === 文件加载 ===
async function loadAudioBlob(blob, name) {
  state.audioBlob = blob;            // 原始 blob 始终用于 STT（体积小）
  state.audioName = name || 'recording';
  // MediaRecorder 的 WebM/Ogg(Opus) 容器无 Cues 索引，点击靠后文本设置 currentTime
  // 会被浏览器钳制回 0（“只能从头播放”）。先解码重编码为可精确 seek 的 WAV 仅供播放。
  let playBlob = blob;
  try {
    playBlob = await toSeekableBlob(blob);
  } catch (e) {
    console.warn('音频转码失败，使用原始格式播放：', e);
  }
  if (els.audio.src) URL.revokeObjectURL(els.audio.src);
  els.audio.src = URL.createObjectURL(playBlob);
  const note = playBlob !== blob ? ' · 已转码可定位' : '';
  els.audioMeta.textContent = `${name || '录音'} · ${(blob.size / 1024).toFixed(1)} KB · ${blob.type || '未知格式'}${note}`;
  els.audio.load();
  primeDuration(els.audio);
}

// MediaRecorder 的 WebM/Opus 不写时长，加载后 duration 会是 Infinity，
// 导致点击靠后文本时 currentTime 越界被钳制回 0（”只能从头开始”）。
// 强制浏览器跳到”无穷远”触发 durationchange，得到真实时长后复位到 0。
// sync.js 的 _seekTo() 也有相同机制作为二重保障。
function primeDuration(audio) {
  const tryResolve = () => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      const onDuration = () => {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
        audio.removeEventListener('durationchange', onDuration);
        try { audio.currentTime = 0; } catch { /* ignore */ }
      };
      audio.addEventListener('durationchange', onDuration);
      try { audio.currentTime = 1e7; } catch { /* ignore */ }
    }
  };
  if (audio.readyState >= 1) {
    tryResolve();
  } else {
    audio.addEventListener('loadedmetadata', tryResolve, { once: true });
  }
}

async function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|webm|ogg|aac|flac)$/i.test(file.name)) {
    toast('请选择音频文件 (MP3/WAV/M4A/WebM)', 'warn');
    return;
  }
  await loadAudioBlob(file, file.name);
  doTranscribe(file, file.name);
}

// === 录音 ===
async function toggleRecord() {
  if (state.recording) {
    setTaskStatus('结束录音…', 'warn');
    try {
      const blob = await recorder.stop();
      state.recording = false;
      els.recToggle.classList.remove('recording');
      els.recToggle.textContent = '🎤 开始录音';
      els.recStatus.textContent = '录音完成 · ' + (blob.size / 1024).toFixed(1) + ' KB';
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const name = `recording-${ts}.webm`;
      await loadAudioBlob(blob, name);
      await doTranscribe(blob, name);
    } catch (e) {
      console.error(e);
      toast('结束录音失败：' + e.message, 'err');
      state.recording = false;
      els.recToggle.classList.remove('recording');
      els.recToggle.textContent = '🎤 开始录音';
    }
    return;
  }
  try {
    await recorder.start();
    state.recording = true;
    els.recToggle.classList.add('recording');
    els.recToggle.textContent = '⏹ 停止录音';
    els.recStatus.textContent = '录音中…';
    // 计时
    const tick = setInterval(() => {
      if (!state.recording) { clearInterval(tick); return; }
      els.recStatus.textContent = '录音中… ' + recorder.elapsedSec().toFixed(1) + 's';
    }, 200);
  } catch (e) {
    toast('无法开始录音：' + e.message, 'err');
  }
}

// === 语音指令 ===
async function toggleVoiceCmd() {
  if (!Storage.isApiConfigured()) {
    toast('请先配置 API', 'warn'); openSettings(); return;
  }
  if (state.voiceCmdRecording) {
    els.voiceCmd.classList.remove('recording');
    els.voiceCmd.textContent = '🎙 语音指令';
    state.voiceCmdRecording = false;
    setTaskStatus('解析语音指令…', 'warn');
    try {
      const blob = await voiceRecorder.stop();
      const tr = await transcribe(blob, { filename: 'voicecmd.webm' });
      const text = tr.segments.map((s) => s.text).join('');
      const cmd = parseCommand(text);
      if (!cmd) {
        toast(`未识别为指令：${text || '(空)'}\n请说『把X改为Y』`, 'warn');
        setTaskStatus('指令未识别', 'warn');
        return;
      }
      const rule = Storage.addRule({ pattern: cmd.from, replacement: cmd.to, source: 'voice' });
      // 立即对当前转写应用一次
      let hits = 0;
      if (state.transcript) {
        hits = Evolution.applyDict(state.transcript);
        renderAll();
      }
      refreshDictPanel();
      toast(`已学习：${cmd.from} → ${cmd.to}（本次命中 ${hits}）`, 'ok');
      setTaskStatus(`已学习：${cmd.from} → ${cmd.to}`, 'ok');
    } catch (e) {
      console.error(e);
      toast('语音指令失败：' + e.message, 'err');
      setTaskStatus('指令失败', 'err');
    }
    return;
  }
  try {
    await voiceRecorder.start();
    state.voiceCmdRecording = true;
    els.voiceCmd.classList.add('recording');
    els.voiceCmd.textContent = '⏹ 完成指令';
    setTaskStatus('请说『把X改为Y』…', 'warn');
  } catch (e) {
    toast('无法录制指令：' + e.message, 'err');
  }
}

// === 编辑模式 ===
function toggleEdit() {
  if (!state.transcript) { toast('请先转写一段音频', 'warn'); return; }
  if (state.editing) {
    state.editing = false;
    els.transcript.removeAttribute('contenteditable');
    els.editToggle.textContent = '✏ 编辑模式';
    // 收集修改：把每个 .seg 的纯文本与原始 segments[].text 比对
    const segEls = els.transcript.querySelectorAll('.seg');
    const candidates = [];
    segEls.forEach((segEl, i) => {
      const txt = stripMeta(segEl.innerText || segEl.textContent || '');
      const orig = state.originalSegmentTexts[i] || '';
      if (txt !== orig) {
        candidates.push(...Evolution.diffRulesFromText(orig, txt));
      }
      // 把编辑后的文本写回 transcript：词级别无法精确对应字符，简化为整段重置（保留段时间，丢失词级时间）
      const seg = state.transcript.segments[i];
      if (seg && txt !== orig) {
        const chars = Array.from(txt);
        if (chars.length > 0) {
          const total = Math.max(0.001, seg.end - seg.start);
          const step = total / chars.length;
          seg.words = chars.map((ch, k) => ({
            start: seg.start + k * step,
            end: seg.start + (k + 1) * step,
            text: ch,
          }));
          seg.text = txt;
        }
      }
    });
    // 提示用户是否把候选规则加入字典
    if (candidates.length > 0) {
      const summary = candidates
        .map((r) => `${r.pattern} → ${r.replacement}`)
        .join('\n');
      if (confirm(`检测到以下修改，加入进化字典？\n\n${summary}`)) {
        candidates.forEach((r) => Storage.addRule({ ...r, source: 'diff' }));
        refreshDictPanel();
        toast(`已加入 ${candidates.length} 条规则`, 'ok');
      }
    }
    // 重新渲染（恢复 word-span 与同步）
    renderAll();
    state.originalSegmentTexts = state.transcript.segments.map((s) => s.text);
  } else {
    state.editing = true;
    els.transcript.setAttribute('contenteditable', 'true');
    els.transcript.focus();
    els.editToggle.textContent = '✓ 完成编辑';
    toast('编辑模式：可直接键入修改。点击不会跳转音频。', '');
  }
}

function stripMeta(txt) {
  // 去掉段首的时间戳标记 "00:12 "
  return txt.replace(/^\s*\d{2}:\d{2}\s*/g, '').trim();
}

// === 重转 ===
async function doRetranscribe() {
  if (!state.audioBlob) { toast('请先加载音频', 'warn'); return; }
  await doTranscribe(state.audioBlob, state.audioName);
}

// === 导出 ===
function exportMeta() {
  return {
    sourceName: state.audioName || 'recording',
    model: state.transcript._model,
    dictHits: Evolution.getSessionHits(),
  };
}
function exportMarkdown() {
  if (!state.transcript) { toast('暂无可导出内容', 'warn'); return; }
  downloadMarkdown(state.transcript, exportMeta());
  toast('已导出 Markdown', 'ok');
}
async function copyMarkdownToClipboard() {
  if (!state.transcript) { toast('暂无可复制内容', 'warn'); return; }
  const ok = await copyMarkdown(state.transcript, exportMeta());
  if (ok) toast('已复制 Markdown 到剪贴板', 'ok');
  else toast('复制失败，请改用「导出 Markdown」', 'err');
}

// === 全局刷新 ===
function refreshAll() {
  setApiStatus();
  refreshPresetSelect();
  renderSettings();
  refreshDictPanel();
}

// === 工具 ===
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// === 事件绑定 ===
function bindEvents() {
  // 顶栏
  els.openSettings.onclick = openSettings;
  els.closeSettings.onclick = closeSettings;
  els.settingsMask.addEventListener('click', (e) => {
    if (e.target === els.settingsMask) closeSettings();
  });
  els.presetSelect.onchange = () => {
    Storage.setActivePreset(parseInt(els.presetSelect.value, 10));
    refreshAll();
    updatePromptHint();
    toast('已切换基座：' + Storage.getActivePreset().name, 'ok');
  };

  // 设置弹窗：字段改动即时保存
  els.cfgName.oninput = () => saveDetailField({ name: els.cfgName.value.trim() || '未命名预设' });
  els.cfgSttBase.oninput = () => saveDetailField({ sttBaseUrl: els.cfgSttBase.value.trim() });
  els.cfgSttKey.oninput = () => saveDetailField({ sttApiKey: els.cfgSttKey.value.trim() });
  els.cfgSttModel.oninput = () => saveDetailField({ sttModel: els.cfgSttModel.value.trim() });
  els.cfgChatBase.oninput = () => saveDetailField({ chatBaseUrl: els.cfgChatBase.value.trim() });
  els.cfgChatKey.oninput = () => saveDetailField({ chatApiKey: els.cfgChatKey.value.trim() });
  els.cfgChatModel.oninput = () => saveDetailField({ chatModel: els.cfgChatModel.value.trim() });

  // 密码可见性
  bindEye(els.cfgSttKey, els.cfgSttEye);
  bindEye(els.cfgChatKey, els.cfgChatEye);

  // ＋ 添加预设（按厂商模板新建，先配置、再手动激活）
  els.addPresetSelect.onchange = () => {
    const id = els.addPresetSelect.value;
    els.addPresetSelect.value = '';
    const tpl = Storage.PROVIDER_PRESETS.find((t) => t.id === id);
    if (!tpl) return;
    _selectedPresetIdx = Storage.addPreset({
      name: tpl.id === 'custom' ? '未命名预设' : tpl.name,
      sttBaseUrl: tpl.sttBaseUrl,
      sttModel: tpl.sttModel,
    });
    renderSettings();
    refreshPresetSelect();
    els.cfgSttKey.focus();
  };

  // 激活 / 删除所选预设
  els.detailActivate.onclick = () => {
    Storage.setActivePreset(_selectedPresetIdx);
    refreshAll();
    updatePromptHint();
    toast('已切换基座：' + Storage.getActivePreset().name, 'ok');
  };
  els.detailDelete.onclick = () => {
    const cfg = Storage.getApiConfig();
    if (cfg.presets.length <= 1) { toast('至少保留一个预设', 'warn'); return; }
    const p = cfg.presets[_selectedPresetIdx];
    if (!confirm(`确认删除预设「${p?.name || '未命名预设'}」？`)) return;
    Storage.deletePreset(_selectedPresetIdx);
    _selectedPresetIdx = Math.min(_selectedPresetIdx, Storage.getApiConfig().presets.length - 1);
    refreshAll();
  };

  // 厂商模板：自动填 Base URL 与默认模型（不动 API Key），即时保存
  els.cfgSttTemplate.onchange = () => {
    const tpl = Storage.PROVIDER_PRESETS.find((t) => t.id === els.cfgSttTemplate.value);
    els.cfgSttTemplate.value = '';
    if (!tpl) return;
    els.cfgSttBase.value = tpl.sttBaseUrl;
    els.cfgSttModel.value = tpl.sttModel;
    saveDetailField({ sttBaseUrl: tpl.sttBaseUrl, sttModel: tpl.sttModel });
  };
  els.cfgChatProvider.onchange = () => {
    const tpl = Storage.CHAT_PROVIDER_PRESETS.find((t) => t.id === els.cfgChatProvider.value);
    els.cfgChatProvider.value = '';
    if (!tpl) return;
    els.cfgChatBase.value = tpl.chatBaseUrl;
    els.cfgChatModel.value = tpl.chatModel;
    saveDetailField({ chatBaseUrl: tpl.chatBaseUrl, chatModel: tpl.chatModel });
  };

  // 测试连接（分别测 STT 与对话模型）
  els.cfgSttTest.onclick = async () => {
    const p = Storage.getApiConfig().presets[_selectedPresetIdx];
    if (!p?.sttBaseUrl || !p?.sttApiKey) {
      toast('请先填写 STT Base URL 和 API Key 再测试', 'warn');
      return;
    }
    setTaskStatus('测试 STT 连接中…', 'warn');
    try {
      await runTest(els.cfgSttTest, () => pingConfig(p));
      setTaskStatus('STT 连接正常', 'ok');
      toast('STT 连接成功', 'ok');
    } catch (e) {
      setTaskStatus('连接失败', 'err');
      toast('连接失败：' + e.message, 'err');
    }
  };
  els.cfgChatTest.onclick = async () => {
    const p = Storage.getApiConfig().presets[_selectedPresetIdx];
    if (!p?.chatBaseUrl || !p?.chatApiKey || !p?.chatModel) {
      toast('请先填写对话模型的 Base URL、API Key 与模型 ID 再测试', 'warn');
      return;
    }
    setTaskStatus('测试对话模型中…', 'warn');
    try {
      await runTest(els.cfgChatTest, () => pingChatConfig(p));
      setTaskStatus('对话模型连接正常', 'ok');
      toast('对话模型连接成功', 'ok');
    } catch (e) {
      setTaskStatus('连接失败', 'err');
      toast('连接失败：' + e.message, 'err');
    }
  };

  // 转写提示词（文本框直接编辑）
  els.promptText.oninput = () => {
    Storage.setSttPrompt(els.promptText.value);
    _syncCheckboxes();
    updatePromptHint();
  };

  // 导入贵州方言词库（可选）
  els.importDialect.onclick = () => {
    const total = GUIZHOU_DIALECT_PRESET.length;
    if (!confirm(`将导入 ${total} 条贵州方言常用词到进化字典（已存在的同名词条会被更新）。继续？`)) return;
    let count = 0;
    GUIZHOU_DIALECT_PRESET.forEach((r) => {
      if (Storage.addRule({ pattern: r.pattern, replacement: r.replacement, source: 'preset' })) count++;
    });
    // 若已有转写，立即应用一次
    if (state.transcript) {
      const hits = Evolution.applyDict(state.transcript);
      renderAll();
      toast(`已导入方言词库 ${count} 条（本次命中 ${hits}）`, 'ok');
    } else {
      refreshDictPanel();
      toast(`已导入方言词库 ${count} 条`, 'ok');
    }
  };

  // 文件上传 / 拖拽
  els.dropzone.onclick = () => els.fileInput.click();
  els.fileInput.onchange = (e) => handleFile(e.target.files?.[0]);
  ['dragenter', 'dragover'].forEach((ev) => {
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      els.dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      els.dropzone.classList.remove('dragover');
    });
  });
  els.dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });

  // 录音 / 语音指令 / 编辑 / 重转
  els.recToggle.onclick = toggleRecord;
  els.voiceCmd.onclick = toggleVoiceCmd;
  els.editToggle.onclick = toggleEdit;
  els.retranscribe.onclick = doRetranscribe;

  // 进化中心
  els.ruleAddBtn.onclick = () => {
    const pattern = els.rulePattern.value.trim();
    const replacement = els.ruleReplacement.value.trim();
    if (!pattern || !replacement) { toast('原始与正确表达均需填写', 'warn'); return; }
    Storage.addRule({ pattern, replacement, source: 'manual' });
    els.rulePattern.value = ''; els.ruleReplacement.value = '';
    // 立即应用一次
    if (state.transcript) {
      const hits = Evolution.applyDict(state.transcript);
      renderAll();
      toast(`已学习：${pattern} → ${replacement}（命中 ${hits}）`, 'ok');
    } else {
      refreshDictPanel();
      toast(`已学习：${pattern} → ${replacement}`, 'ok');
    }
  };

  // 导出 / 复制
  els.exportMd.onclick = exportMarkdown;
  els.copyMd.onclick = copyMarkdownToClipboard;

  // 调试：D 键打印 drift
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'd') {
      console.log('[sync drift]', Sync.debugDrift());
    }
  });
}

// === 初始化 ===
function init() {
  if (els.buildStamp) els.buildStamp.textContent = 'build ' + BUILD;
  populateTemplateSelects();
  bindEvents();
  initPromptUI();
  refreshAll();
  updatePromptHint();
  if (!Storage.isApiConfigured()) {
    setTimeout(openSettings, 200);
  }
}

init();
