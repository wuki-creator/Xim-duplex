# 模思模型在伴点里的分工

更新：2026-11-16 · v0.7.1。依据 [模思官网模型目录](https://home.mosi.cn/models)、[模思 API 模型清单](https://platform.moss.cn/docs/models/) 和模型维护者的文档。官网开源模型名称与云端 API ID 不一定一一对应。

| 模型 / 家族 | 在伴点里的用途 | 目前状态 |
| --- | --- | --- |
| MOSS-Live | 双向实时语音、边听边说、插话后让出话语权，流式字幕 | 已通过真实 API 的合成音频检查；真人接话体验仍需复测 |
| Nex N2.6 | 选配文字对话、理解纠正与保留表情标签 | API 适配与 DeepSeek 回退已实现；需要密钥并显式选择 |
| MOSS-Transcribe / Transcribe-Diarize | 基础语音备用转写；多人结果提示请单独重说 | 两个模型 API 已适配；需显式启用；当前仍用已验收的 Whisper |
| MOSS-TTS 1.5 Flash | 基础语音的可选中文角色声线，按短段取消；失败回退到设备朗读 | API 已适配；需密钥和 TTS 音色 ID；此实现按段取 WAV |
| MOSS-TTS / Local Transformer v1.5 | 高质量角色固定台词或未来自部署音频服务 | 设计候选，未部署独立权重 |
| MOSS-TTS-Realtime | 自部署路径的上下文感知流式合成 | 候选；应与 Live 的原生声音或现有 TTS 做对照，避免同一回复合成两遍 |
| MOSS-TTS-Nano / Audio Tokenizer Nano | 无云端 TTS 的终端设备候选，Tokenizer 是语音解码底层 | 待按目标硬件测试；未下载或部署到产品 |
| MOSS-Audio（4B/8B Instruct/Thinking） | 经授权的音频理解与重叠场景评测，后续可做异步环境音分类 | 待部署；不从声音自动推断用户心理状态，不阻塞每轮回复 |
| MOSS-VoiceGenerator | 从角色描述设计一套原创音色，确认后固定用于 TTS | 素材制作候选；需要生成并保存音色，再把 ID 填到相应服务 |
| MOSS-TTSD | 双人示范、角色对练示例或播客片段 | 素材制作候选，不进入单人即时对话 |
| MOSS-SoundEffect | 可选的启动、庆祝等短提示音 | 素材制作候选；停播逻辑不能被音效延迟 |
| MOVA | 生成跟声音同步的演示片段 | 素材制作候选；现有 Three.js 表情仍由浏览器实时渲染 |
| MOSS-VL / VL Realtime，MOSS-Image | 视觉问答、视频理解、设计素材 | 当前只做对话且不开摄像头；保持为后续独立功能候选 |

一个话轮只选一条主路：实时语音由 MOSS-Live 完成输入、输出及插话；基础语音走 ASR → 对话模型 → TTS。模思视觉、多说话人配音和音视频生成不参与逐句推理。这样可以逐项比较首句等待、误抢话、纠正后答对率和主观自然度。

## 开启云端适配

1. 在 [模思控制台](https://platform.moss.cn/) 生成有相应权限的 API Key。在启动伴点的终端设置 `MOSS_API_KEY`，或者把密钥填到仓库忽略的 `private/moss.json`。请勿把密钥放进前端或推到 GitHub。全新安装不带密钥；基础聊天可独立运行。
2. 重启 Node 服务后刷新页面。语音区出现“基础语音 / 实时语音”。选择实时语音再开启，麦克风音频发给模思；不会开启摄像头。使用基础语音则保持当前 Whisper，除非另行打开云端转写。
3. 可选配置按所需能力单独添加：

```json
{
  "api_key": "填写模思 API Key",
  "live": true,
  "chat": "moss",
  "asr": "moss-transcribe-diarize-pro",
  "tts_voice_id": "单人 TTS 的音色 ID",
  "live_voice_id": "实时语音可用的音色 ID"
}
```

初试建议只填 `api_key`，先比较基础语音与实时语音。`chat`、`asr`、音色 ID 均可省略。单人 TTS 与实时的可用音色按各自接口确认，两个 ID 不互换。项目不会主动克隆声音。启用 `chat` 会发送当前文字及短窗口上下文；启用 `asr` 会发送分段音频；配置 TTS 音色会向模思发送要朗读的回复文字。参考 [计费与模型权限](https://platform.moss.cn/docs/models/)。

实时会话使用模型侧的会话级上下文。客户端根据声卡输出时间确认音频块，收到停播事件会报告当前块已播时长、清空未播队列；附和不会被本地能量阈值强制抢停。字幕的临时结果不写入文字模型请求，已确认的用户字幕按轮次修订。切换到打字会结束实时语音，保留界面上的字幕；独立文字通道的上下文不会自动与实时会话合并。

v0.7.1 合并连续已确认片段和后续修订。等约 2.8 秒没有音频时出现「接着回答」；有明确内容、麦克风近期无明显语音、没有待播音频时，约 6.5 秒可自动转交基础语音。单纯附和和明确要求等待不自动转交。兜底以已确认的文字和当前对话上下文发起基础回复，同一个 WebSocket 与麦克风继续工作。短时间的分段和后端转录修订不会新增重复的用户消息。

测试覆盖真实合成语音、播放回执、同连接切换至 Whisper，以及模拟实时回复缺失时的完整客户端交接。尚无真人停播延迟或插话成功率数据。请用同一设备分别试“嗯嗯”附和、“不是工作，是家里”纠正、“等下换个话题”插话和外放回声，再决定生产默认路线。

相关文档：[实时协议](https://platform.moss.cn/docs/reference/moss-live/) · [语音合成](https://platform.moss.cn/docs/reference/speech/) · [识别和分角色](https://platform.moss.cn/docs/reference/transcriptions/) · [MOSS-Audio](https://github.com/OpenMOSS/MOSS-Audio) · [TTS 家族](https://github.com/OpenMOSS/MOSS-TTS) · [Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano) · [MOVA](https://github.com/OpenMOSS/MOVA)。
