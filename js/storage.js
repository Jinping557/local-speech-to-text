// storage.js — localStorage 持久化
// Keys: qyl.apiConfig（含 presets 列表 + activePreset 索引）、qyl.evolutionDict

const KEY_API = 'qyl.apiConfig';
const KEY_DICT = 'qyl.evolutionDict';
const KEY_PROMPT = 'qyl.sttPrompt';

const DEFAULT_PRESET = {
  name: '通用 Whisper',
  sttBaseUrl: 'https://api.openai.com/v1',
  sttApiKey: '',
  sttModel: 'whisper-1',
  chatBaseUrl: '',
  chatApiKey: '',
  chatModel: '',
};

// 常见厂商模板：选择名字即自动填入 Base URL 与默认模型，只需再填 API Key。
// id 为 'custom' 时不覆盖任何字段。
export const PROVIDER_PRESETS = [
  { id: 'custom',      name: '自定义',             sttBaseUrl: '',                                                  sttModel: '' },
  { id: 'openai',      name: 'OpenAI',             sttBaseUrl: 'https://api.openai.com/v1',                         sttModel: 'whisper-1' },
  { id: 'siliconflow', name: 'SiliconFlow 硅基流动', sttBaseUrl: 'https://api.siliconflow.cn/v1',                    sttModel: 'FunAudioLLM/SenseVoiceSmall' },
  { id: 'dashscope',   name: '阿里通义 DashScope',  sttBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', sttModel: 'paraformer-realtime-v2' },
  { id: 'groq',        name: 'Groq',               sttBaseUrl: 'https://api.groq.com/openai/v1',                    sttModel: 'whisper-large-v3' },
];

// 对话/纠错模型厂商模板。需要支持 /chat/completions 的大语言模型（LLM），不是 STT 模型。
export const CHAT_PROVIDER_PRESETS = [
  { id: 'custom',      name: '自定义',                    chatBaseUrl: '',                                                  chatModel: '' },
  { id: 'deepseek',    name: 'DeepSeek ⭐ 性价比首选',    chatBaseUrl: 'https://api.deepseek.com/v1',                      chatModel: 'deepseek-chat' },
  { id: 'siliconflow', name: 'SiliconFlow（DeepSeek-V3）', chatBaseUrl: 'https://api.siliconflow.cn/v1',                   chatModel: 'deepseek-ai/DeepSeek-V3' },
  { id: 'dashscope',   name: '阿里通义 Qwen-Turbo',       chatBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chatModel: 'qwen-turbo' },
  { id: 'groq',        name: 'Groq（免费额度）',           chatBaseUrl: 'https://api.groq.com/openai/v1',                   chatModel: 'llama-3.3-70b-versatile' },
  { id: 'openai',      name: 'OpenAI GPT-4o-mini',        chatBaseUrl: 'https://api.openai.com/v1',                        chatModel: 'gpt-4o-mini' },
];

function readJSON(key, fallback) {
  try {
    const s = localStorage.getItem(key);
    if (!s) return fallback;
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function writeJSON(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

export function getApiConfig() {
  const cfg = readJSON(KEY_API, null);
  if (!cfg || !Array.isArray(cfg.presets) || cfg.presets.length === 0) {
    return { presets: [{ ...DEFAULT_PRESET }], activePreset: 0 };
  }
  if (cfg.activePreset >= cfg.presets.length) cfg.activePreset = 0;
  return cfg;
}

export function saveApiConfig(cfg) {
  writeJSON(KEY_API, cfg);
}

export function getActivePreset() {
  const cfg = getApiConfig();
  return cfg.presets[cfg.activePreset];
}

export function setActivePreset(index) {
  const cfg = getApiConfig();
  if (index < 0 || index >= cfg.presets.length) return;
  cfg.activePreset = index;
  saveApiConfig(cfg);
}

export function upsertPreset(preset, index = -1) {
  const cfg = getApiConfig();
  if (index >= 0 && index < cfg.presets.length) {
    cfg.presets[index] = { ...cfg.presets[index], ...preset };
  } else {
    cfg.presets.push({ ...DEFAULT_PRESET, ...preset });
    cfg.activePreset = cfg.presets.length - 1;
  }
  saveApiConfig(cfg);
  return cfg;
}

export function deletePreset(index) {
  const cfg = getApiConfig();
  if (cfg.presets.length <= 1) return cfg;
  cfg.presets.splice(index, 1);
  if (cfg.activePreset >= cfg.presets.length) cfg.activePreset = cfg.presets.length - 1;
  saveApiConfig(cfg);
  return cfg;
}

export function isApiConfigured() {
  const p = getActivePreset();
  return Boolean(p && p.sttBaseUrl && p.sttApiKey && p.sttModel);
}

// === 转写提示词（全局，跨会话记忆；默认空 = 无）===

export function getSttPrompt() {
  try {
    return localStorage.getItem(KEY_PROMPT) || '';
  } catch {
    return '';
  }
}

export function setSttPrompt(text) {
  try {
    localStorage.setItem(KEY_PROMPT, text || '');
  } catch {
    /* ignore */
  }
}

// === Evolution dictionary ===

export function getDict() {
  const d = readJSON(KEY_DICT, []);
  return Array.isArray(d) ? d : [];
}

export function saveDict(dict) {
  writeJSON(KEY_DICT, dict);
}

export function addRule({ pattern, replacement, source = 'manual' }) {
  if (!pattern || !replacement || pattern === replacement) return null;
  const dict = getDict();
  // 去重：相同 pattern 直接更新 replacement
  const existing = dict.find((r) => r.pattern === pattern);
  if (existing) {
    existing.replacement = replacement;
    existing.source = source;
    saveDict(dict);
    return existing;
  }
  const rule = {
    id: 'r_' + Math.random().toString(36).slice(2, 10),
    pattern,
    replacement,
    source,
    hits: 0,
    createdAt: Date.now(),
  };
  dict.push(rule);
  saveDict(dict);
  return rule;
}

export function deleteRule(id) {
  const dict = getDict().filter((r) => r.id !== id);
  saveDict(dict);
  return dict;
}

export function updateRule(id, { pattern, replacement }) {
  if (!pattern || !replacement || pattern === replacement) return null;
  const dict = getDict();
  const r = dict.find((x) => x.id === id);
  if (!r) return null;
  // 检查是否会与其他词条 pattern 冲突
  const conflict = dict.find((x) => x.id !== id && x.pattern === pattern);
  if (conflict) return { error: 'duplicate', conflictId: conflict.id };
  r.pattern = pattern;
  r.replacement = replacement;
  r.updatedAt = Date.now();
  saveDict(dict);
  return r;
}

export function bumpHits(id, n = 1) {
  const dict = getDict();
  const r = dict.find((x) => x.id === id);
  if (r) {
    r.hits += n;
    saveDict(dict);
  }
}
