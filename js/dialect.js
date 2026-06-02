// dialect.js — 可选导入的贵州方言常用词库
// 每条 { pattern, replacement }：pattern 为转写常见的方言写法/识别结果，replacement 为对应的通用普通话表达。
// 仅在用户主动点击「导入方言词库」时写入进化字典，非默认行为。
// 注意：字典为子串替换，故只收录多字、辨识度高的词，避免单字规则误伤无关文本。

export const GUIZHOU_DIALECT_PRESET = [
  { pattern: '搞哪样', replacement: '干什么' },
  { pattern: '弄啥子', replacement: '干什么' },
  { pattern: '啷个', replacement: '怎么' },
  { pattern: '咋个', replacement: '怎么' },
  { pattern: '莫得', replacement: '没有' },
  { pattern: '没得', replacement: '没有' },
  { pattern: '要得', replacement: '可以' },
  { pattern: '不晓得', replacement: '不知道' },
  { pattern: '晓得', replacement: '知道' },
  { pattern: '巴适', replacement: '舒服' },
  { pattern: '摆龙门阵', replacement: '聊天' },
  { pattern: '龙门阵', replacement: '闲聊' },
  { pattern: '相因', replacement: '便宜' },
  { pattern: '默倒', replacement: '以为' },
  { pattern: '记倒', replacement: '记住' },
  { pattern: '哈数', replacement: '分寸' },
  { pattern: '撒子', replacement: '什么' },
  { pattern: '瓜娃子', replacement: '傻瓜' },
  { pattern: '哈儿', replacement: '傻子' },
  { pattern: '老汉儿', replacement: '父亲' },
  { pattern: '堂客', replacement: '妻子' },
  { pattern: '卡卡角角', replacement: '角落' },
  { pattern: '搞快点', replacement: '快一点' },
  { pattern: '慢慢叽叽', replacement: '慢吞吞' },
  { pattern: '切饭', replacement: '吃饭' },
];
