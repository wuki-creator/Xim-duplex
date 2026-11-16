# Xim 自主部署与微调基线

更新：2026-11-16 · v0.8.1。Xim 是本项目自己的产品名；衍生模型保留原模型来源、许可证和版本信息，不能通过改名移除上游归属或许可要求。

## 当前已落地

- 浏览器独立录音和可打断播放，远端服务器自建 Whisper 转写；只向指定机器传输语音，不依赖第三方 ASR API。
- 对话层可选择本机 / SSH 转发的 OpenAI-compatible 模型；服务地址只接受 HTTP 回环接口，不能从配置传入外网地址。故障时在已有 DeepSeek 配置的情况下回退；DeepSeek 继续提供会议及工作台的复杂多任务能力。
- `localNanoSpeech` 可连接自部署 [MOSS-TTS-Nano ONNX app](https://github.com/OpenMOSS/MOSS-TTS-Nano)，走它的 `/api/generate`，验证返回的 WAV 并对外提供取消与长度限制。尚未在本机启用此模型，当前仍使用浏览器系统声音或已配置的云语音。
- 会议的确认后任务最多两项并行，各自保留方案版本与结果，参考 [AutoGen 多 Agent 协作](https://github.com/microsoft/autogen)中的角色/消息/执行分工；本项目没有引入 AutoGen 依赖，也没有假称 Agent 可以控制外部系统。
- 物理工作台以浏览器 Cannon 刚体场景为主；借鉴 [Isaac Lab](https://github.com/isaac-sim/IsaacLab)对仿真与机器人任务分层的思路。新轨迹求解器对每个轨迹点的**末端**做保守障碍盒检查；不覆盖机械臂各关节连杆、连续碰撞或真实硬件约束。服务器旧版忽略障碍输入时强制回退到本机新版，不静默跳过检查。

## 模型接口与开关

在仓库忽略的 `private/local-models.json` 设置以下字段后重启 `server.mjs`。默认保留现有实时语音，以便不打断已验证的使用方式；要试自己的本地级联，明确选择 `voice_mode: local`：

```json
{
  "voice_mode": "local",
  "chat_url": "http://127.0.0.1:18080",
  "chat_model": "在本机服务中加载的模型名",
  "tts_url": "http://127.0.0.1:18083",
  "tts_demo_id": "demo-1"
}
```

也可用 `.env.example` 中对应的 `XIM_` 环境变量。局域网或服务器服务须通过本机 SSH 端口转发；不要把无认证的推理服务开放给公网。`demo-1` 是上游演示音频条件，仅用于技术验证，不能直接当作已授权商用角色声音；产品声音须审查音频和人格权授权。自部署 Nano 的上游 ONNX 网页服务启动见 [官方说明](https://github.com/OpenMOSS/MOSS-TTS-Nano#onnx-local-web-demo-with-app_onnxpy)。该工作机的 Windows 应用控制曾阻止新安装的原生组件，推荐在允许依赖的独立 Linux 环境运行，不能通过关闭或规避该控制处理。

Xim 的本地路线是语音检测 → 整句转写 → 文本对话 → 分段合成，能够中断播放；它不是原生同时收听与说话的端到端全双工模型。MOSS-Live 公开页面介绍了托管系统，但没有提供可直接替换的公开完整权重，不能凭借 TTS 微调宣称复现 Live。模型改结构需要额外训练与基准评估。

## 已选公开数据与准备

[AISHELL-3](https://www.openslr.org/93) 数据页面标注 Apache 2.0，约 85 小时、218 名普通话说话人，为中性语音。其适合作为发音和多说话人基础数据，不能代替开心、安慰、插话等情绪和对话训练集。商业产品需要保留归属和许可证，并核验个人声音和具体使用方式的授权；不把现有说话人声音直接包装成已取得角色声音授权。

已固定公开仓库修订 `e1c7e4f38ef3fdd1b35b44066b53eb05498f458d`，抓取三名说话人各 10 条作为**开发样本**。脚本生成 20 条训练、10 条未见说话人的留出样本；它只验证文本、WAV 格式和划分，不是有效训练量。数据和中间产物存于 `data/`，不进入 GitHub。

```powershell
python scripts/fetch_aishell3_sample.py --output data/aishell3-sample --per-speaker 10
python scripts/prepare_aishell3.py --root data/aishell3-sample --output data/aishell3-sample-prepared --eval-speakers 1
```

完整 AISHELL-3 公开包约 19 GB。对完整包运行相同准备脚本后，训练集及评估集按说话人隔离，输出来源、原始标注摘要与数据量。公开 Nano [训练流程](https://github.com/OpenMOSS/MOSS-TTS-Nano/blob/main/finetuning/README.md)包括音频编码、SFT 和验证。已准备 `training/run_nano.sh`：只调用指定版本的上游训练脚本，拒绝不足 1000 条训练 / 100 条留出样本、说话人重叠和覆盖已有训练输出。它没有自动触发训练，也不从测试数据学习。

运行训练前需要 Python 3.10+、匹配上游版本的依赖、原始模型及音频 tokenizer 权重，确保训练样本与验证集在训练机器上可读。服务器当前默认 Python 3.8、没有该模型依赖，已检测到，因此没有声称训练或权重改造完成。需要搭建隔离环境并完成预处理后才能启动 GPU SFT。

## 训练后的验收

保留原版权重和新 checkpoint，记录上游代码/模型 SHA、数据清单、超参数和计算资源。比较基线与微调版的中文内容错误、发音、主观自然度、不同说话人与文本的泛化、首音/整句延迟；情绪风格需使用额外授权样本及独立人工盲评。没有足够人类反馈时，不能把提示词策略更新当作模型权重自进化或宣传效果提升。
