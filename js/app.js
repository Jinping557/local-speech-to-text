// app.js — 入口与编排
import * as Storage from './storage.js';
import { transcribe, ApiError } from './api.js';
import { Recorder } from './recorder.js';
import { render as renderTranscript, getTranscript, getFlatWords, formatTime } from './transcript.js';
import * as Sync from './sync.js';
import * as Evolution from './evolution.js';
import { parseCommand } from './voicecmd.js';
import { downloadMarkdown } from './export.js';
import { GUIZHOU_DIALECT_PRESET } from './dialect.js';

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
  cfgProvider: $('cfg-provider'),
  cfgName: $('cfg-name'),
  cfgSttBase: $('cfg-stt-base'),
  cfgSttKey: $('cfg-stt-key'),
  cfgSttModel: $('cfg-stt-model'),
  cfgChatBase: $('cfg-chat-base'),
  cfgChatKey: $('cfg-chat-key'),
  cfgChatModel: $('cfg-chat-model'),
  cfgSave: $('cfg-save'),
  cfgTest: $('cfg-test'),
  presetList: $('preset-list'),
  promptPreset: $('prompt-preset'),
  promptCustom: $('prompt-custom'),
  importDialect: $('import-dialect'),
  dictCount: $('dict-count'),
  dictHits: $('dict-hits'),
  rulePattern: $('rule-pattern'),
  ruleReplacement: $('rule-replacement'),
  ruleAddBtn: $('rule-add-btn'),
  ruleList: $('rule-list'),
  ruleListCount: $('rule-list-count'),
  exportMd: $('export-md'),
  statusApi: $('status-api'),
  statusTask: $('status-task'),
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

// === 设置抽屉 ===
function openSettings() {
  els.settingsMask.classList.remove('hidden');
  fillFormFromActive();
  refreshPresetList();
}
function closeSettings() {
  els.settingsMask.classList.add('hidden');
}
function fillFormFromActive() {
  const p = Storage.getActivePreset();
  els.cfgProvider.value = 'custom';
  els.cfgName.value = p.name || '';
  els.cfgSttBase.value = p.sttBaseUrl || '';
  els.cfgSttKey.value = p.sttApiKey || '';
  els.cfgSttModel.value = p.sttModel || '';
  els.cfgChatBase.value = p.chatBaseUrl || '';
  els.cfgChatKey.value = p.chatApiKey || '';
  els.cfgChatModel.value = p.chatModel || '';
}
// 厂商预设下拉：选名字自动填 Base URL 与默认模型（不动 API Key）
function populateProviderSelect() {
  els.cfgProvider.innerHTML = '';
  Storage.PROVIDER_PRESETS.forEach((tpl) => {
    const opt = document.createElement('option');
    opt.value = tpl.id;
    opt.textContent = tpl.name;
    els.cfgProvider.appendChild(opt);
  });
}
function applyProviderTemplate(id) {
  const tpl = Storage.PROVIDER_PRESETS.find((t) => t.id === id);
  if (!tpl || tpl.id === 'custom') return;
  els.cfgSttBase.value = tpl.sttBaseUrl;
  els.cfgSttModel.value = tpl.sttModel;
  if (!els.cfgName.value.trim()) els.cfgName.value = tpl.name;
}

function readForm() {
  return {
    name: els.cfgName.value.trim() || '未命名预设',
    sttBaseUrl: els.cfgSttBase.value.trim(),
    sttApiKey: els.cfgSttKey.value.trim(),
    sttModel: els.cfgSttModel.value.trim() || 'whisper-1',
    chatBaseUrl: els.cfgChatBase.value.trim(),
    chatApiKey: els.cfgChatKey.value.trim(),
    chatModel: els.cfgChatModel.value.trim(),
  };
}
function refreshPresetList() {
  const cfg = Storage.getApiConfig();
  els.presetList.innerHTML = '';
  cfg.presets.forEach((p, i) => {
    const li = document.createElement('li');
    if (i === cfg.activePreset) li.classList.add('active');
    li.innerHTML = `
      <div class="preset-info">
        <div class="preset-name">${escapeHtml(p.name)}</div>
        <div class="preset-meta">${escapeHtml(p.sttModel)} · ${escapeHtml(p.sttBaseUrl)}</div>
      </div>
      <div class="preset-actions">
        <button class="btn use">${i === cfg.activePreset ? '✓ 使用中' : '激活'}</button>
        <button class="btn edit">编辑</button>
        <button class="btn del" title="删除">✕</button>
      </div>
    `;
    li.querySelector('.use').onclick = () => { Storage.setActivePreset(i); refreshAll(); };
    li.querySelector('.edit').onclick = () => loadPresetIntoForm(i);
    li.querySelector('.del').onclick = () => {
      if (cfg.presets.length <= 1) { toast('至少保留一个预设', 'warn'); return; }
      if (!confirm('确认删除该预设？')) return;
      Storage.deletePreset(i);
      refreshAll();
    };
    els.presetList.appendChild(li);
  });
}
let _editingPresetIdx = -1;
function loadPresetIntoForm(idx) {
  const cfg = Storage.getApiConfig();
  const p = cfg.presets[idx];
  if (!p) return;
  els.cfgProvider.value = 'custom';
  els.cfgName.value = p.name;
  els.cfgSttBase.value = p.sttBaseUrl;
  els.cfgSttKey.value = p.sttApiKey;
  els.cfgSttModel.value = p.sttModel;
  els.cfgChatBase.value = p.chatBaseUrl || '';
  els.cfgChatKey.value = p.chatApiKey || '';
  els.cfgChatModel.value = p.chatModel || '';
  _editingPresetIdx = idx;
  toast('已载入预设到编辑表单，修改后点"保存为预设"', '');
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
function initPromptUI() {
  const saved = Storage.getSttPrompt();
  const options = Array.from(els.promptPreset.options).map((o) => o.value);
  if (!saved) {
    els.promptPreset.value = '';
    els.promptCustom.classList.add('hidden');
  } else if (options.includes(saved)) {
    els.promptPreset.value = saved;
    els.promptCustom.classList.add('hidden');
  } else {
    // 与任何示例都不匹配 → 视为自定义
    els.promptPreset.value = '__custom__';
    els.promptCustom.value = saved;
    els.promptCustom.classList.remove('hidden');
  }
}
// 返回当前生效的提示词（空串表示无）
function getCurrentPrompt() {
  if (els.promptPreset.value === '__custom__') return els.promptCustom.value.trim();
  return els.promptPreset.value;
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
    const tr = await transcribe(blob, {
      filename: sourceName || 'audio',
      prompt: getCurrentPrompt() || undefined,
    });
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    // 字典拦截
    const hits = Evolution.applyDict(tr);
    state.transcript = tr;
    state.originalSegmentTexts = tr.segments.map((s) => s.text);
    renderAll();
    setTaskStatus(`转写完成 ${elapsed}s · 字典命中 ${hits}`, 'ok');
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
  renderTranscript(state.transcript, els.transcript);
  Sync.bind({
    audio: els.audio,
    flatWords: getFlatWords(),
    container: els.transcript,
  });
  refreshDictPanel();
}

// === 文件加载 ===
function loadAudioBlob(blob, name) {
  state.audioBlob = blob;
  state.audioName = name || 'recording';
  if (els.audio.src) URL.revokeObjectURL(els.audio.src);
  els.audio.src = URL.createObjectURL(blob);
  els.audioMeta.textContent = `${name || '录音'} · ${(blob.size / 1024).toFixed(1)} KB · ${blob.type || '未知格式'}`;
  els.audio.load();
  primeDuration(els.audio);
}

// MediaRecorder 的 WebM/Opus 不写时长，加载后 duration 会是 Infinity，
// 导致点击靠后文本时 currentTime 越界被钳制回 0（“只能从头开始”）。
// 这里强制浏览器跳到“无穷远”读出真实时长，再复位到 0，使整段可跳转。
function primeDuration(audio) {
  const onMeta = () => {
    audio.removeEventListener('loadedmetadata', onMeta);
    if (audio.duration === Infinity || Number.isNaN(audio.duration)) {
      const onSeek = () => {
        audio.removeEventListener('timeupdate', onSeek);
        try { audio.currentTime = 0; } catch { /* ignore */ }
      };
      audio.addEventListener('timeupdate', onSeek);
      try { audio.currentTime = 1e7; } catch { /* ignore */ }
    }
  };
  audio.addEventListener('loadedmetadata', onMeta);
}

function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|webm|ogg|aac|flac)$/i.test(file.name)) {
    toast('请选择音频文件 (MP3/WAV/M4A/WebM)', 'warn');
    return;
  }
  loadAudioBlob(file, file.name);
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
      loadAudioBlob(blob, name);
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
function exportMarkdown() {
  if (!state.transcript) { toast('暂无可导出内容', 'warn'); return; }
  downloadMarkdown(state.transcript, {
    sourceName: state.audioName || 'recording',
    model: state.transcript._model,
    dictHits: Evolution.getSessionHits(),
  });
  toast('已导出 Markdown', 'ok');
}

// === 全局刷新 ===
function refreshAll() {
  setApiStatus();
  refreshPresetSelect();
  refreshPresetList();
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
    toast('已切换基座：' + Storage.getActivePreset().name, 'ok');
  };

  // 设置表单
  els.cfgSave.onclick = () => {
    const p = readForm();
    if (!p.sttBaseUrl || !p.sttApiKey) {
      toast('Base URL 和 API Key 必填', 'warn'); return;
    }
    Storage.upsertPreset(p, _editingPresetIdx);
    _editingPresetIdx = -1;
    refreshAll();
    toast('已保存预设', 'ok');
  };
  els.cfgTest.onclick = async () => {
    // 用表单当前值测试，无需先保存为预设
    const p = readForm();
    if (!p.sttBaseUrl || !p.sttApiKey) {
      toast('请先填写 Base URL 和 API Key 再测试', 'warn');
      return;
    }
    setTaskStatus('测试连接中…', 'warn');
    try {
      const { pingConfig } = await import('./api.js');
      await pingConfig(p);
      setTaskStatus('连接正常', 'ok');
      toast('连接成功', 'ok');
    } catch (e) {
      setTaskStatus('连接失败', 'err');
      toast('连接失败：' + e.message, 'err');
    }
  };

  // 厂商预设选择
  els.cfgProvider.onchange = () => applyProviderTemplate(els.cfgProvider.value);

  // 转写提示词
  els.promptPreset.onchange = () => {
    if (els.promptPreset.value === '__custom__') {
      els.promptCustom.classList.remove('hidden');
      els.promptCustom.focus();
      Storage.setSttPrompt(els.promptCustom.value.trim());
    } else {
      els.promptCustom.classList.add('hidden');
      Storage.setSttPrompt(els.promptPreset.value);
    }
  };
  els.promptCustom.oninput = () => {
    if (els.promptPreset.value === '__custom__') {
      Storage.setSttPrompt(els.promptCustom.value.trim());
    }
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

  // 导出
  els.exportMd.onclick = exportMarkdown;

  // 调试：D 键打印 drift
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'd') {
      console.log('[sync drift]', Sync.debugDrift());
    }
  });
}

// === 初始化 ===
function init() {
  bindEvents();
  populateProviderSelect();
  initPromptUI();
  refreshAll();
  if (!Storage.isApiConfigured()) {
    setTimeout(openSettings, 200);
  }
}

init();
