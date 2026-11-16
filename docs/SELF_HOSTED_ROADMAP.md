# Xim 自部署配置

更新：2026-11-16。运行时不调用 MOSS 云 API；现支持可选的本地 MOSS Nano 参数，具体状态见[模型架构](XIM_MOSS_ARCHITECTURE.md)。三种空间共用自部署识别服务；主对话的应用状态控制收听、停播和上下文续接。

## 当前可运行的默认路线

麦克风 → Xim VAD → SSH 连接的 Whisper → 自托管语言模型 → 情绪文字 / Three.js / 本地 MOSS Nano 语音或设备朗读。语音输入在输出期间保持开启。这是可插话的级联原型；整句识别和整段文本生成仍造成等待，不等于原生端到端全双工模型。

会议空间和物理工作台使用自托管语言模型处理结构化任务，并使用既有固定计算服务。图片服务没有默认外部供应商；未部署时会返回 `IMAGE_NOT_CONFIGURED`，不自动把图片请求发给其他平台。

## 可替换的模型服务

`private/local-models.json` 为本机私有配置，Git 忽略。以下为接口配置示例，不表示端口已有模型运行；未使用的字段应省略。

```json
{
  "chat_url": "http://127.0.0.1:18080",
  "chat_model": "实际加载的文本模型名",
  "tts_url": "http://127.0.0.1:18083",
  "tts_model": "实际加载的语音模型名",
  "tts_voice": "已授权的音色标识",
  "image_url": "http://127.0.0.1:18084",
  "image_model": "实际加载的图像模型名"
}
```

- 文本：`POST /v1/chat/completions`，兼容 messages/choices 协议。主对话、会议与工作台共用本地模型；失败时明确报错，不回退到外部模型 API。
- 声音：`POST /v1/audio/speech`，JSON 包含 `model,input,voice,response_format: wav,emotion`，返回原始 WAV，最大 4 MB。未配置或失败时采用设备朗读。它是通用协议，模型需要部署适配服务，不能直接指向任意原生服务。
- 图片：`POST /v1/images/generations`，请求一张 768×768 图片，JSON `data[0].b64_json` 返回 PNG/JPEG；拒绝远程图片 URL、SVG 和过大响应。
- 所有模型地址只允许 HTTP 回环，远端模型通过 SSH 转发。不向这些地址发送任何外部 API 密钥。识别仍使用 `private/asr.json` 与 `/health`、`/transcribe`。

环境变量见 [.env.example](../.env.example)。v0.8.1 的 `tts_demo_id` 与 Nano `/api/generate` 不再支持；旧 `private/moss.json` 和 `MOSS_*` 云设置不再读取。现有私有配置将 TTS 指向自建 Nano 服务；服务故障回退设备朗读。图像模型未部署。具体的模型、音色来源和评估范围见[模型架构](XIM_MOSS_ARCHITECTURE.md)。

随仓库提供 `scripts/local_chat_worker.py`：从本地目录加载 Qwen2.5-1.5B-Instruct，在单 GPU 上监听回环地址，提供 `/health` 与 `/v1/chat/completions`。它要求匹配的 CUDA、PyTorch、Transformers、Jinja2 和经过校验的模型文件；不自动联网下载。当前为验证用途的串行推理服务，不具备真正的模型生成中止或高并发生产调度。取消请求可阻止旧回答进入前端，但服务端已开始的计算可能继续到当前生成完成。

## 数据与训练

公开数据选择与自主研发边界见 [模型路线](MODEL_STRATEGY.md)，样本准备和训练计划见 [training/README.md](../training/README.md)。完整模型训练前还需要隔离环境、权重、足够样本、预处理和独立评测；本版本没有训练产物。
