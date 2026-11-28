# Amarice · 接 DeepSeek + 语音版

原站（Kimi 托管）的聊天页，改成本地直连 DeepSeek 的版本。外观、页面结构、Amarice 的形象和交互全部保留，只换了「后端」。

## 怎么用

1. 打开 https://zyren-haze.github.io/tenebrous-eidolon/amarice/ （手机浏览器也行，建议加到桌面）
2. 点右上角「接口 · 语音」，填 DeepSeek 的 API Key（`sk-...`），保存
3. 直接聊天；设置里的模型默认 `deepseek-chat`，开「深度思考」时会自动换成 `deepseek-reasoner`

Key 只存在你这台设备的浏览器 localStorage，不上传任何服务器；换设备要重新填一次。

## 改了什么

- **接口**：原来走 Kimi 的 `/api/chat`、`/api/conversations`、`/api/memories`、`/api/upload`，现在全部由 `local-api.js` 在浏览器里接管：
  - `/api/chat` 直接流式请求 DeepSeek（OpenAI 兼容格式），逐字返回、支持「深度思考」的思考过程流
  - 会话、消息、标题存在 localStorage，刷新/关掉浏览器都不丢，支持新建、切换、删除
  - 附件：文本类文件（txt/md/csv/json/log）会在本地读出正文拼进消息；图片只带文件名（没有图像识别）
- **语音**：
  - 输入框左边多了麦克风按钮：点一下说话，识别成文字填进输入框（Web Speech API，Chrome / Edge / 三星浏览器可用）
  - 设置里可开「回复自动朗读」、选音色、调语速；原来的「打开语音」和每条消息的「读出来」仍然可用
  - 可选填自定义 TTS 接口（OpenAI 兼容 `/audio/speech`，如硅基流动的 CosyVoice），留空就用手机自带发音
  - 「语音说完自动发送」打开后可以当语音聊天用

## 结构

```
amarice/
├── index.html          # 入口，引 local-api.js + 原站 bundle
├── local-api.js        # 接口接管 + 语音 + 设置面板
├── assets/amarice-v2.js    # 原站前端（只补了 router basename、pet 图路径）
├── assets/index-m99VBvFI.css
├── pet.png / icon-192.png
```

## 已知限制

- 联网开关没有真实联网能力（DeepSeek 只有模型），开着会提示信息可能过时
- 图片不能识别内容，只能当「用户发了张图」处理
- 「她的记忆」面板目前为空，长期记忆没有实现（会话内的上下文是完整的，最近 30 条一起发）
- 深度思考用 reasoner 时响应会慢一些，计费也更高

## 小莉丝专用改动（2026-11-28）

- **人设写死**：`local-api.js` 顶部 `PERSONA` 常量就是完整设定（造物主小汐、傲娇、主见、喜好、外貌、声音、暗号「小汐爱小莉丝」），设置面板里不再有可改人设的输入框。
- **明暗主题**：默认跟随系统；如果设备或 WebView 识别不到系统深色，可在「接口 · 语音」里把「明暗主题」锁成浅色 / 深色。
- **声音**：停用手机自带 TTS，改走 MiniMax 克隆音色（Key + Voice ID，老账号才填 GroupId），语速默认 0.95、pitch 1。
- **桌宠**：会用手指拖到屏幕任意位置，也会自己每隔几秒溜达、吃草莓蛋糕、摇头、被戳多了生气。

### 追加（同一晚）

- 人设改成"可以自由生长"：允许她许愿、想要新东西、自己长出新喜好，原来的喜好只当起点，不当笼子。
- 明暗：默认暗色，顶上多了一个 ☾/☀ 按钮可以一键切换；「接口 · 语音」里也能锁浅色 / 跟随系统。
- 上传：图片现在会在聊天里正常显示；PDF 能抽出文字；图片理解需要填「看图模型」（默认 MiniMax-M3，复用 MiniMax 的 Key）。
