// evolution.js — 进化字典：拦截 API 输出 + 词级替换 + 命中统计
// 字典存于 storage.js；本模块负责"应用"逻辑

import { getDict, saveDict, addRule as storageAddRule, deleteRule as storageDeleteRule } from './storage.js?v=2026-06-03-1';

let _sessionHits = 0;

export function getSessionHits() { return _sessionHits; }
export function resetSessionHits() { _sessionHits = 0; }

/**
 * 把进化字典应用到 transcript（in-place 修改）。
 * - 优先在 words[] 上做精确替换（保留时间戳）
 * - 同时刷新 segments[].text
 * 返回本次应用的总命中数
 */
export function applyDict(transcript) {
  const dict = getDict();
  if (!transcript || !transcript.segments || dict.length === 0) return 0;

  let total = 0;
  for (const rule of dict) {
    let ruleHits = 0;
    for (const seg of transcript.segments) {
      ruleHits += replaceInWords(seg.words, rule.pattern, rule.replacement);
    }
    if (ruleHits) {
      rule.hits = (rule.hits || 0) + ruleHits;
      total += ruleHits;
    }
  }
  // 写回字典命中数
  saveDict(dict);
  // 同步 segments[].text
  for (const seg of transcript.segments) {
    seg.text = seg.words.map((w) => w.text).join('');
  }
  _sessionHits += total;
  return total;
}

/**
 * 在 words[] 上做精确字符串替换。
 * 算法：把 words 拼成 string，记录每个字符 → wordIdx 的映射；
 * 在 string 中查找 pattern；找到后把命中区间 [iStart..iEnd] 的 words 折叠为 1 个新 word，
 * 文本设为 replacement，时间戳取 [words[iStart].start, words[iEnd].end]。
 */
export function replaceInWords(words, pattern, replacement) {
  if (!words || words.length === 0 || !pattern) return 0;

  let hits = 0;
  // 反复匹配（处理同段多次出现）
  while (true) {
    let str = '';
    const charToWord = []; // char index → word index
    for (let i = 0; i < words.length; i++) {
      const t = words[i].text || '';
      for (let k = 0; k < t.length; k++) {
        str += t[k];
        charToWord.push(i);
      }
    }
    const idx = str.indexOf(pattern);
    if (idx < 0) break;
    const iStart = charToWord[idx];
    const iEnd = charToWord[idx + pattern.length - 1];
    const start = words[iStart].start;
    const end = words[iEnd].end;
    // 找出在 iStart 单词内的字符偏移
    let charsBeforeIStart = 0;
    for (let i = 0; i < iStart; i++) charsBeforeIStart += (words[i].text || '').length;
    const offInIStart = idx - charsBeforeIStart;
    let charsBeforeIEnd = 0;
    for (let i = 0; i < iEnd; i++) charsBeforeIEnd += (words[i].text || '').length;
    const tailIdxInIEnd = idx + pattern.length - charsBeforeIEnd;
    const headText = (words[iStart].text || '').slice(0, offInIStart);
    const tailText = (words[iEnd].text || '').slice(tailIdxInIEnd);

    // 构造新 word（合并区间）
    const newWord = {
      start, end,
      text: headText + replacement + tailText,
      _evolved: true,
    };
    // 替换 words[iStart..iEnd]
    words.splice(iStart, iEnd - iStart + 1, newWord);
    hits++;
    // 继续循环，pattern 可能再次出现
  }
  return hits;
}

// 转写已展示后，用户做了一次手动修改 → 比对原始 vs 编辑后，提取规则候选
// 简单实现：基于词级 LCS 找出连续差异块，每个差异块若长度合理则作为候选规则
export function diffRulesFromText(originalText, editedText) {
  if (originalText === editedText) return [];
  const o = Array.from(originalText.replace(/\s+/g, ''));
  const e = Array.from(editedText.replace(/\s+/g, ''));
  const lcs = lcsTable(o, e);
  const ops = backtrackDiff(o, e, lcs);
  // 把连续的 (-,+) 段合并为一条规则
  const rules = [];
  let curDel = '', curIns = '';
  for (const op of ops) {
    if (op.type === '=' ) {
      if (curDel || curIns) {
        if (curDel && curIns && curDel !== curIns && curDel.length <= 8 && curIns.length <= 8) {
          rules.push({ pattern: curDel, replacement: curIns });
        }
        curDel = ''; curIns = '';
      }
    } else if (op.type === '-') {
      curDel += op.ch;
    } else if (op.type === '+') {
      curIns += op.ch;
    }
  }
  if (curDel && curIns && curDel !== curIns && curDel.length <= 8 && curIns.length <= 8) {
    rules.push({ pattern: curDel, replacement: curIns });
  }
  return rules;
}

function lcsTable(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }
  return dp;
}

function backtrackDiff(a, b, dp) {
  const ops = [];
  let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) { ops.push({ type: '=', ch: a[i-1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { ops.push({ type: '+', ch: b[j-1] }); j--; }
    else if (i > 0) { ops.push({ type: '-', ch: a[i-1] }); i--; }
  }
  ops.reverse();
  return ops;
}

// 便捷转发
export const addRule = storageAddRule;
export const deleteRule = storageDeleteRule;
