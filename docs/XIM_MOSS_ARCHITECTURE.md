# Xim 与 MOSS 参数的关系

更新：2026-11-16。用户要求借鉴 MOSS、使用公开参数，并设计有区别的算法。这里区分原模型、Xim 新增代码和尚未完成的训练，不把模型改名等同于从零开发。

v0.9.3 新增自托管 Smart Turn 话轮预测、有限交互状态和单段语音预取。实际链路与待训练的动作条件世界模型分开记录在[世界模型路线](WORLD_MODEL_PLAN.md)。

## 公开架构

- [MOSS-TTS-Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano) 使用音频 tokenizer 与自回归文本/音频 token 生成；[MOSS-Audio-Tokenizer-Nano](https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano) 将音频映射为低帧率离散代码并解码。
- [MOSS-TTS-Realtime](https://github.com/OpenMOSS/MOSS-TTS/blob/main/moss_tts_realtime/README.md) 文档描述 1.7B 主干加 200M 局部 Transformer 的分层结构，支持流式文本输入与音频输出；它是语音合成，不是完整对话系统。
- [MOSS-Live](https://github.com/OpenMOSS/MOSS-Live) 对外介绍前台实时交互与后台推理和任务执行的分工；公开页面提供在线体验及 API。当前没有找到可供独立加载和微调的完整 Live 权重，因此不能宣称复现其内部网络或训练目标。

## 本次实际参数来源

下载自 Hugging Face 的原版权重，仅存本机及服务器私有目录，不进入 Git。下载时核对了完整文件 SHA-256：

| 组件 | revision | 权重 SHA-256 |
| --- | --- | --- |
| [MOSS-TTS-Nano-100M](https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M) | `44502f80dbf9743528fa921cc544d662c685ebec` | `24003f2f11ac8a2cbf70514db2d8f1c02fb451aa6b3c0bffc9da09f31cd7caa5` |
| [MOSS-Audio-Tokenizer-Nano](https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano) | `6aa02b01e445cc585582cf0ba480bc3ea6c8dd68` | `34d9880d805eecb21bde975202b1c256dbd0eb98c8680b9d3aeffd2bc6ac2f67` |

推理使用 [OpenMOSS 官方代码](https://github.com/OpenMOSS/MOSS-TTS-Nano) 固定 revision `8b7bcc9341b3b4ef3a3a58ba1338a7d85ff133eb`，由 `scripts/xim_moss_speech_worker.py` 封装成本机服务。当前机器配置的是服务器 CPU 版、AISHELL-3 开发样本作研究参考音色，非已完成商业声音授权审查的产品音色。原项目代码为 Apache-2.0。模型卡元数据标记 Apache-2.0，但 Nano 卡中的许可证段落和文件布局存在需要核实之处，产品发行前应核实权重、配套模型及角色音色的具体授权。

## Xim 新增算法与边界

1. **打断事件策略**：`turn-policy.mjs` 根据已确认的可见内容，对打断后的文字区分纠正、请求让话、简短附和及其他输入；在发送模型时添加不同的回应约束。规则只影响新回答，不修改模型隐藏思维。它运行在整句识别之后，不提供附和发生时的实时声学判别，当前 VAD 仍可能误停播。
2. **情绪条件残差层**：`training/xim_moss_adapter.py` 在 Nano 全局解码器输出上增加低秩残差：`h' = h + Up(tanh(Down(h) + E[emotion]))`。新增部分以零值输出初始化，初始等于原模型；仅在显式提供并验证独立 adapter checkpoint 时启用。它作用于当前返回的隐藏状态，不改写基础 KV 缓存。序列化请求并限制情绪枚举，避免会话间串用状态。
3. **表达事件**：语音服务使用回复段落的情绪标签，作为适配层条件；用户界面继续同步角色表情。模型、数据、适配器和部署服务分别记录版本，不能把标签映射等同于情绪被模型真实理解。

以上是可测试的 Xim 原型设计，不是已证明新颖或优于 MOSS 的模型。当前没有训练适配器权重，没有情绪音色的真人盲评；默认不加载适配器。现有输入仍是整句 Whisper，输出采用短段音频，不能称为端到端全双工。前端可撤销未完成播放和丢弃过期结果，但服务器上已经开始的合成不会立即中止。

## 训练与验收

音频合成的监督需合法的文本—语音配对数据，情绪控制还要真实情绪标签或人类偏好标注；语义轮次训练需要双人交互、时间标注和独立会话留出集。当前 30 条 AISHELL-3 中性录音只供接口和格式调试。生成的数据不得直接替代真实用户偏好或真实打断评测。

适配器应先冻结基础模型、按说话人和会话隔离数据，再以同基座对照评估语音自然度、内容错误、情绪恰当性及首音延迟。新版本需要无回归、可回滚和明确的来源记录；未经有效评测不得自动晋级。
