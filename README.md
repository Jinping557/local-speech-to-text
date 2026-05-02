# 黔音留痕 · 方言口述历史抢救系统（Demo MVP）

[![GitHub Pages](https://img.shields.io/badge/Demo-Live-brightgreen)](https://jinping557.github.io/local-speech-to-text/)

> **在线演示**：[https://jinping557.github.io/local-speech-to-text/](https://jinping557.github.io/local-speech-to-text/)
> （需要自带 STT API Key，Key 仅存于本机浏览器，不上传任何服务器。）

针对贵州复杂山地垂直方言环境的口述历史采集与编辑工具。开放式接入主流语音大模型 API，支持音文双向同步、即时校正与本地"进化字典"自学习。

> 本项目为 **纯静态前端**（HTML + CSS + 原生 ES Module），零构建。API Key 仅保存在本机浏览器 `localStorage`，浏览器直接调用 OpenAI 兼容协议的 STT 接口。

---

## 启动

由于使用了 ES Module，**不能直接 `file://` 打开**，需要走 HTTP：

```bash
# Python 3
python3 -m http.server 8000

# 或 Node
npx http-server -p 8000
```

然后浏览器打开 <http://localhost:8000/>。建议使用 **Chrome / Edge / Firefox** 最新版（需要 `MediaRecorder` 与 `<audio>` 解码 MP3/M4A 的支持）。

---

## 配置 API

首次启动会自动弹出设置抽屉。需要填：

| 字段 | 说明 | 示例 |
|---|---|---|
| 预设名称 | 给基座起个名字，便于切换 | `通用 Whisper` / `阿里通义 Paraformer` |
| STT Base URL | OpenAI 兼容的根地址 | `https://api.openai.com/v1` |
| STT API Key | 厂商分配的 Key | `sk-...` |
| STT 模型 | 模型 ID | `whisper-1` |

> 任何兼容 OpenAI `/audio/transcriptions` 协议的厂商均可（OpenAI、Groq、SiliconFlow、阿里通义、Together 等）。可保存多个预设，顶栏一键切换。

可选：Chat 模型字段为预留接入位（PRD 提到的 DeepSeek 等），当前版本暂未启用 Chat 通道。

---

## Demo 演示路径（对应 PRD §4）

1. **环境配置**：⚙ 设置 → 填入 API Key/Base URL/模型 → 保存。
2. **数据导入**：左侧 *拖拽/点击上传* 一段贵州方言音频（MP3/WAV/M4A/WebM），或点击 🎤 现场录音。
3. **云端识别**：上传后系统自动转写，转写区显示带时间戳的文字。底部状态栏显示耗时。
4. **音文比对**：
   - **点击文本任意词** → 音频跳到对应位置开始播放。
   - **拖动音频进度条** → 文本中当前词高亮、自动滚入视野（rAF 驱动，<200ms 精度）。
5. **即时校正**：
   - 方式 A：点击 ✏ 编辑模式，直接键入修改 → 完成后系统提示"是否将差异加入字典"。
   - 方式 B：点击 🎙 语音指令，说一句"**把吃饭改为切饭**"（也支持"改成"）→ 系统自动学习并立即应用。
   - 方式 C：在右侧"进化中心"手动添加 `原始 → 正确` 对。
6. **见证进化**：再次上传/录制含相同词汇的音频 → API 返回原始文字 → 本地字典即时拦截 → 屏幕上直接显示正确版本，"进化中心"命中数 +1。
7. **导出存档**：点击底部 📥 导出 Markdown，得到带时间戳的 `.md` 文件。

---

## 验收对照（PRD §5）

| 验收项 | 检验方式 |
|---|---|
| API 连通性 | 设置抽屉点"测试连接"，或上传短音频后转写区出现文本。 |
| 同步精度 < 200ms | 播放时按 `Alt+D` 控制台打印 `drift` 值；正常应 < 0.2 秒。 |
| 校正即学习 | 添加规则后立即对当前文本生效；下次 STT 回包后字典自动拦截。 |
| Markdown 完整性 | 导出文件含标题、元数据、时间戳段落，UTF-8 无乱码。 |

---

## 文件结构

```
.
├── index.html          # 单页布局
├── styles.css          # 主题 + 三栏布局 + 抽屉/Toast
├── js/
│   ├── app.js          # 入口与编排
│   ├── storage.js      # localStorage：apiConfig / evolutionDict
│   ├── api.js          # OpenAI 兼容 STT 客户端 + verbose_json 归一化
│   ├── recorder.js     # MediaRecorder 包装
│   ├── transcript.js   # 渲染 word-span DOM
│   ├── sync.js         # rAF 双向同步引擎
│   ├── evolution.js    # 进化字典：拦截 / 词级替换 / diff→规则
│   ├── voicecmd.js     # 语音指令解析（"把X改为Y"）
│   └── export.js       # Markdown 导出
└── README.md
```

---

## 已知边界与不做项

- 当前仅支持 OpenAI Whisper 兼容协议；自定义协议厂商需在 `js/api.js::transcribe` 中扩展。
- 录音/上传后一次性整段送 API，不做流式增量转写。
- 不持久化音频文件（刷新页面后会话清空，进化字典会保留在 localStorage）。
- 词级时间戳依赖厂商返回 `timestamp_granularities=["word"]`；不返回 word 的厂商，本地按段内字数线性插值（精度会下降）。
- 不引入构建工具、不引入前端框架。

---

## 数据隐私

API Key 与进化字典只保存在你浏览器的 `localStorage`，不会上传到任何第三方服务器（除你自己配置的模型厂商外）。共用电脑请在 ⚙ 设置中删除预设后离开。

---

## License

见 [LICENSE](./LICENSE)。
