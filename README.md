# Xim Duplex · 伴点

一个只保留对话的桌面陪伴机器人原型。Three.js 表情、情绪文字与沉浸式对话舱，搭配独立搭建的持续收听、插话停播和上下文回答链路。

![Xim Duplex](public/media/poster.png)

[观看 ChatCut 演示成片](public/media/xim-demo.mp4) · [验证记录](docs/VALIDATION.md)

## 当前能力

- DeepSeek 服务端调用，结构化输出异常时回退为可读文字；停止与重试不会追加重复的用户消息。
- 浏览器持续录音 → WebSocket → VAD → 本地语音识别 → DeepSeek → 系统语音合成。输出声音时输入保持开启，用户插话会取消旧请求和朗读，丢弃过期识别。
- 语音必须主动点击开启；关闭后立即释放麦克风。无语音服务时仍可打字。
- 六种表情和对应文字色，可关闭颜色与动作；无专注计时、任务执行或提醒页面。
- 自愿提交文字评价，生成可审阅的策略候选；独立真人比较满足门槛后才晋级，并保留旧版本。

这是可插话的级联工程原型，**不是复现 MOSS-Live 权重或经过对照试验的 SOTA 系统**。VAD 是能量阈值，不能可靠地区分附和、噪声和有效插话；使用耳机更稳。系统朗读的音色、可用性与延迟由浏览器及操作系统决定。当前仍等待完整文本后开始朗读。

## 启动

需要 Node.js 22+。Windows 本机运行：

```powershell
npm ci
# 只在本机设置密钥，不写入前端或仓库
$env:DEEPSEEK_API_KEY='你的密钥'
npm start
```

打开 http://127.0.0.1:8788 。也可指定 `XIM_CONFIG` 指向仓库外的私有 JSON 配置，字段为 `api_key`；兼容原有 BandiPrivate 本机配置。

语音识别需要 Python 3.11+。Windows 默认使用已安装的中文听写引擎，建议在 PowerShell 7 的另一个终端启动：

```powershell
./Start_Voice.ps1
```

中文听写引擎须已安装。它在独立进程中保持预热，音频只经内存传递。ASR 服务监听 127.0.0.1:8791。刷新页面，点击「开始语音」，授权麦克风。

设置 `$env:ASR_ENGINE='whisper'` 后运行相同脚本，可安装并使用 faster-whisper。首次安装与下载模型较慢；tiny 是 CPU 起步配置，`ASR_MODEL=small` 可切换模型，GPU 另需匹配 CUDA。该机器的 Windows 应用控制拦截了新装 NumPy 原生组件，因此这里验证的是系统中文识别后端，Whisper 尚未在该机器完成推理验证。不要关闭系统安全控制来加载组件。

Linux/macOS 可创建虚拟环境、安装 `requirements-asr.txt` 后运行 `python scripts/asr_worker.py`。配置项见 `.env.example`；当前不自动读取 `.env`。

## 改进与评估

```powershell
npm test
npm run evolve -- propose data/feedback.jsonl
npm run evolve -- promote path/to/human-evaluation.json
```

候选生成至少需要 10 条已授权负反馈，晋级至少需要 50 条独立真人对照。测试中的合成数据只验证门槛行为，不代表产品已通过真人实验。数据与训练权重不进入 Git。细节、模型组合与官方参考见 [模型方案](docs/MODEL_STRATEGY.md)。

演示视频的镜头、文字和制作状态见 [视频简报](docs/VIDEO_BRIEF.md)。演示用于解释交互，不作为延迟、情绪识别或模型效果的实测证据。

## 数据范围

密钥只保留在服务端。对话默认只在当前页面内存中，服务端为评价暂存最多 100 条回答，刷新/重启不会恢复对话。音频不落盘；勾选授权并点击评价后，对应输入、回答及评价写入本机 `data/feedback.jsonl`。删除该文件可移除反馈记录。

这是个人本地服务，默认仅监听回环地址。公开部署前另需账号隔离、服务端会话、HTTPS、用量控制和部署级隐私设计。

第三方软件和模型说明见 [THIRD_PARTY.md](THIRD_PARTY.md)。
