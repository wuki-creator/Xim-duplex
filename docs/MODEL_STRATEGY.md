# Xim Duplex 模型组合与递归改进

本产品仅提供对话。前台为音频接收、播放和三维表情，后台为语音识别和对话推理。各模块通过消息协同，不直接拼接不兼容的权重。

v0.7.0 更新：[模思模型分工和可选配置](MOSI_INTEGRATION.md)。目前默认仍为 Whisper + DeepSeek；MOSS-Live、Nex、模思转写、角色 TTS 适配代码已加入，正式启用需要模思密钥。

## 已实现的独立方案

- 浏览器 AudioWorklet 持续发送 16 kHz 单声道 PCM，朗读时输入保持开启。
- Node 侧独立 VAD 按 160 ms 连续有声、700 ms 静音切分；这是初始阈值，不是经过人群实验的最优参数。
- 收到 speech.start 后停止朗读、取消旧对话请求，并记录播放前缀。连续语音片段按顺序保留，用户仍讲话时不抢先提交回答。录音不写磁盘。
- 可替换识别 → DeepSeek 文本对话 → 系统语音合成。v0.6.2 当前机器通过 SSH 使用服务器 Whisper Small（CPU INT8，8 线程）；三条合成语音及静音检查通过，用户已确认真实讲话能被识别，复杂重叠场景待验证。本机 NumPy 仍受应用控制限制，没有启用被拦截组件。Windows 中文听写保留为兼容路径，其真人测试失败记录保留。
- UI 反馈只有显式勾选授权并点击评价才保存对应文字；音频不进入偏好训练数据。

这是具有并行收听和输出、可插话的工程原型。能量 VAD 不具备 MOSS-Live 的语义轮次判断、说话人选择性和“嗯嗯”等附和判断能力，不能据此声称已复现其模型或达到 SOTA。扬声器外放仍有回声风险，原型优先使用耳机。

## MOSI / OpenMOSS 模型分工

| 模型 | 适用角色 | 接入决策 |
| --- | --- | --- |
| MOSS-Live | 连续音频输入输出、选择性注意、自然插话 | 官方托管接口已做可选适配；客户端音频流与播放确认经模拟验证；当前没有模思凭据，基本链路不依赖它。 |
| MOSS-TTS-Realtime | 流式文字转语音 | 后续替换系统朗读，可用 vLLM-Omni 对接；需 GPU 服务和实际首包延迟验证。 |
| MOSS-TTS-Nano | CPU / 浏览器轻量语音 | 适合玩具端候选，需核验目标芯片的实时系数、音质及分块取消能力。 |
| MOSS-Transcribe-Diarize | 语音转写与说话人信息 | 适合录音评估和离线标注；本轮低延迟路径先用独立 ASR。 |
| MOSS-Audio | 环境音理解 | 可异步提供语音场景标签，避免每句话同步串行推理拖慢回应。 |
| MOSS-TTSD / VoiceGenerator | 多人演示配音、品牌声音 | 用于内容生产；不放进每轮实时回答的关键路径。 |
| DeepSeek | 对话理解与回答 | 已通过服务端接入；API 使用不等于拥有可微调的模型权重。 |

开源代码与模型权重的许可证须逐个确认。MOSS-TTS / TTSD 项目页面声明 Apache-2.0；MOSS-Live 托管 API 的账户条款不能由其他仓库的许可代替。本仓库不分发 MOSS 权重。

## 递归自进化的可执行边界

闭环：用户自愿评价 → 汇总失败模式 → 候选策略继承父版本 → 固定独立测试集及盲评 → 通过统计门槛 → 晋级 → 新一轮反馈。

`evolution/evolve.mjs` 已实现策略候选、父版本校验、盲评报告门槛和保存上一版。至少 10 条真实授权负反馈才产生候选；至少 50 条不同 holdout 案例、有评审人、无回归、95% Wilson 胜率下界 > 0.5、P95 回复延迟 ≤ 4 秒、P95 停播 ≤ 500 ms 才允许晋级。阈值是产品目标，不是已测结果。

此版本做提示策略改进，不声称模型权重自训练。没有足够真人数据时不自动制造偏好标签，也不以模型自评分替代人类结论。后续可在合法可训练权重上做 SFT/DPO；训练集与固定验证集按用户和会话分开，保持模型、数据、提示和推理参数的版本记录。

## 应做的对照实验

相同设备、网络、声音与用户任务，对比：独立级联方案、MOSS-Live、级联方案 + MOSS-TTS-Realtime。测量首音延迟、停播延迟、转写错误率、误打断、背景声误响应、上下文纠正、用户偏好、每分钟成本。报告设备、模型版本、样本数、置信区间；至少覆盖安静、外放、多人和弱网场景。只有完成该对照，才能判断哪个组合更好。

## 官方来源（2026-11-16 核查）

- 模思博客：https://home.mosi.cn/blog
- MOSS-Live 项目：https://github.com/OpenMOSS/MOSS-Live
- 实时接口协议：https://platform.moss.cn/en/docs/reference/moss-live
- MOSS-TTS 家族：https://github.com/OpenMOSS/MOSS-TTS
- MOSS-TTSD：https://github.com/OpenMOSS/MOSS-TTSD
- MOSS-Audio：https://github.com/OpenMOSS/MOSS-Audio
- vLLM-Omni 配方：https://github.com/vllm-project/vllm-omni/blob/main/recipes/OpenMOSS/MOSS-TTS.md
