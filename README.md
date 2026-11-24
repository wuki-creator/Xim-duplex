# Xim Duplex · 伴点

伴点是一个自托管的桌面陪伴机器人原型。它在朗读时继续收音：听到新讲话就暂停，听清「嗯嗯」可以续播，听到纠正则取消旧回复。主对话也能创建虚拟会议，或把「添加一个红色方块」交给浏览器里的物理工作台。

![伴点对话界面](public/media/poster.png)

[观看演示](public/media/xim-demo.mp4) · [验证记录](docs/VALIDATION.md) · [全链路推理公式](docs/INFERENCE.md)

## 本地启动

需要 Node.js 22+。先在终端设置 `XIM_LOCAL_CHAT_URL` 和 `XIM_LOCAL_CHAT_MODEL`，分别指向本机或经 SSH 转发的自托管文本服务及其模型名。也可写入 `private/local-models.json` 的 `chat_url`、`chat_model` 字段。配置示例见 [.env.example](.env.example)，启动脚本读取进程环境变量。

```powershell
npm ci
npm start
```

打开 [本机对话页](http://127.0.0.1:8788)。仅启动 Node 服务即可浏览界面，生成回答还需文本模型就绪。

要启用麦克风，在另一个 PowerShell 终端运行 `./Start_Voice.ps1`，刷新页面并点击「实时语音」授权。Windows 默认使用已安装的中文听写引擎，也支持 Whisper 或经 SSH 转发的识别服务。远程识别会将语句音频发送至配置的服务器。可选的 Smart Turn 和语音合成服务分别由 `XIM_TURN_URL` 和 `XIM_LOCAL_TTS_*` 配置。[语音部署指南](docs/ASR_DEPLOYMENT.md)

## 当前可运行的语音链路

```mermaid
flowchart TD
    mic["麦克风 · 16 kHz PCM"] --> vad["能量 VAD · 800 ms 预录"]
    vad --> asr["ASR 整句转写"]
    vad -. 可选 .-> turn["Smart Turn 判断话尾"]
    asr --> gate["提交本轮转写"]
    turn -.-> gate
    gate -->|暂缓中，附和或未听清| resume["继续原回复"]
    gate -->|有效新输入| route{"按意图路由"}
    route -->|普通对话| chat["文本模型生成回复"]
    route -->|会议口令| meeting["创建虚拟会议"]
    route -->|场景口令| scene["转交物理工作台"]
    chat --> play["朗读回复或任务提示"]
    meeting --> play
    scene --> play
```

播放过程中，VAD 检测到起音就暂缓朗读。若转写为「不对，我说的是明天」，系统取消旧回复，再处理纠正后的输入。会议方案须经用户确认才能执行，工作台会校验对象、坐标和允许的动作。[交互流程](docs/MODEL_FLOW.md) · [任务示例](docs/WORKBENCH_AND_MEETING.md)

本地神经语音或设备朗读负责播放。交互记录可导出事件及相对时间。服务端在内存中暂存最近 100 条回答，自愿授权并评价后才将输入、回答和评价写入本机 `data/feedback.jsonl`。[模型与任务调用细节](docs/VOICE_TASK_PIPELINE.md)

## 模型进展与证据

| 部件 | 已验证的范围 |
| --- | --- |
| xim-chat-v1 | Qwen3-8B 的 LoRA SFT 训练 136 步后，100 条合成任务留出样本的正确率从 94% 升至 100%。采用 SFT 检查点。后续 120 步 GRPO 未显示额外收益。[模型卡](docs/XIM_CHAT_V1_MODEL_CARD.md) |
| XimVoiceCond-v1 | 已实现四层块因果 Transformer，输出 896 维语音条件。各层的查询和键复用同一组 RoPE 系数。合成张量测试覆盖增量缓存、因果性和梯度；权重尚未训练。[实现](training/xim_voice_cond.py) |
| CosyVoice 2 接口 | 零初始化门控残差只作用于目标文本嵌入。接口替身已验证调用顺序和生成预算；官方权重与波形合成尚未接入。[适配层](training/xim_cosyvoice2_bridge.py) |

### LiveBridge 目标模型流程

```mermaid
flowchart TD
    mimi["Mimi 编码用户音频"] --> adapt["音频投影与因果时序适配器"]
    adapt --> xim["xim-chat-v1 共享语义表示"]
    state["文字、会话与播放状态"] --> xim
    xim -->|回复语义| cond["XimVoiceCond-v1<br/>896 维语音条件"]
    cond --> bridge["门控残差注入目标文本嵌入"]
    bridge --> cosy["CosyVoice 2 分块合成语音"]
    xim -->|轮次动作与任务提案| control["播放控制与任务校验"]
```

融合权重尚待训练，CosyVoice 2 官方权重尚待接入。真人重叠讲话、开放扬声器回声消除和端到端首音仍待实测。[融合架构与训练路线](docs/FUSION_ARCHITECTURE.md)

固定样本的 ASR、Smart Turn、语言模型、语音合成和 Mimi 编码耗时，以及每项的机器、样本数和统计口径，见[组件实测记录](docs/evaluations/2026-11-23/README.md)。

## 复现测试

```powershell
npm test                         # Node 单元和集成回归，部分用例调用 Python
npm run test:voice-cond          # Python + PyTorch，语音条件契约
npm run test:cosyvoice2-bridge   # Python + PyTorch，CosyVoice 2 接口契约
```

[训练与评估](training/README.md) · [原生双工研究方案](docs/DUPLEX_ARCHITECTURE.md) · [第三方软件与模型](THIRD_PARTY.md)
