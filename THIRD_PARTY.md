# 第三方组件

| 组件 | 使用方式 | 来源与许可 |
| --- | --- | --- |
| Three.js 0.187.0 | 浏览器三维机器人，随仓库分发 | https://github.com/mrdoob/three.js ，MIT；保留 `public/vendor/three-LICENSE.txt` |
| Cannon ES 0.20.0 | 浏览器物理工作台的刚体模拟 | https://github.com/pmndrs/cannon-es ，MIT；通过 npm 安装 |
| ws 8.23.0 | Node WebSocket | https://github.com/websockets/ws ，MIT；通过 npm 安装 |
| faster-whisper | 语音识别服务；当前旧 Python 服务器使用 1.0.3 / CTranslate2 4.4.0，本机依赖清单为 1.2.1 | https://github.com/SYSTRAN/faster-whisper ，MIT；独立安装 |
| Whisper Small / CTranslate2 模型 | 当前服务器识别权重，单独下载，不随仓库分发 | https://huggingface.co/Systran/faster-whisper-small ，按模型卡与上游许可使用；兼容 tiny 配置 |
| Paramiko | SSH 加密转发，独立安装 | https://github.com/paramiko/paramiko ，按上游许可使用；本仓库不分发其包 |
| 系统语音合成 | 浏览器 SpeechSynthesis | 声音可用性与服务条款由浏览器/系统决定 |
| Qwen2.5-1.5B-Instruct | 自托管文本模型候选，权重独立下载，不随仓库分发 | https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct ，模型卡标注 Apache-2.0；记录模型 revision 和权重校验值 |
| Qwen3-8B | `xim-chat-v1` 多任务后训练基座，保持上游来源，权重独立下载 | https://huggingface.co/Qwen/Qwen3-8B ，Apache-2.0；固定版本与实验状态见 `training/README.md` |
| Smart Turn v3.2 | 自托管声学话轮结束判断，权重独立下载 | https://huggingface.co/pipecat-ai/smart-turn-v3 ，BSD-2-Clause；完整许可见 `scripts/SMART_TURN_LICENSE`，固定版本与摘要见 `docs/WORLD_MODEL_PLAN.md` |

## 创业融合目标候选（不是当前运行依赖）

目标采用 Mimi＋自研跨模态适配层＋xim-chat-v1＋CosyVoice 2 的表示级融合，不使用 MOSS，也不直接混合上游权重。组合关系、训练状态和接口见 [融合模型设计](docs/FUSION_ARCHITECTURE.md)。

- Mimi：LiveBridge 目标中的用户音频流式编码器，仅使用编码输出，不使用其解码器，也不把 Moshi 作为 Xim 对话模型。论文／官方仓库：https://arxiv.org/abs/2410.00037 与 https://github.com/kyutai-labs/moshi 。本机微基准使用官方权重，SHA-256 为 `09b782f0629851a271227fb9d36db65c041790365f11bbe5d3d59369cf863f50`；代码、权重及配套模型许可在产品发行前逐项复核。
- CosyVoice 2：分块流式合成候选，尚未在 Xim 部署或实测。论文／官方仓库：https://arxiv.org/abs/2412.10117 与 https://github.com/FunAudioLLM/CosyVoice 。增量文本、角色音色、模型权重和数据授权均须独立审查。
- SpeechTokenizer：语义／声学解耦对照，不进入当前目标主链路，也不作为原生流式证据。ICLR 2024 来源：https://proceedings.iclr.cc/paper_files/paper/2024/hash/86d1ab582afb247ccaa84bec4a7e24f7-Abstract-Conference.html 。

按用户新要求，本版本提供自部署 OpenMOSS Nano 语音适配器；模型参数与上游代码独立下载，不随本仓库分发。来源和权重摘要见 [架构记录](docs/XIM_MOSS_ARCHITECTURE.md)。不读取旧的 `private/moss.json`，也不使用旧的 `MOSS_*` 云接口配置；私有研究文件和数据不随本仓库分发。MOSS Nano 仅是当前 Demo／历史基线，不属于 LiveBridge 目标主链路。

公开语音开发数据 AISHELL-3 来源为 https://www.openslr.org/93 ，页面标注 Apache 2.0；只准备了 30 条格式验证样本，没有训练声音模型。具体角色声音的使用授权需要独立记录。

多任务训练数据：OpenAssistant/oasst2（Apache-2.0）用于已筛选中文监督样本；nvidia/HelpSteer3（CC-BY-4.0）的人类偏好配对已下载、清理并保留来源署名，尚不用于本轮 GRPO；Team-ACE/ToolACE（Apache-2.0）已下载但本轮没有合格中文样本入选。具体修订、修改、用途和划分见 `training/README.md`，原始数据不随仓库分发。

ChatCut 是独立的视频制作工具，不作为应用运行时依赖。项目自有机器人由程序几何建模；研究参考声音来自上述 AISHELL-3 样本，授权边界按其实际用途核实。自建代码、开源基础组件、模型权重和数据分别记录归属，产品品牌不替代第三方许可说明。
