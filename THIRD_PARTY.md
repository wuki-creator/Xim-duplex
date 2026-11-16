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
| Smart Turn v3.2 | 自托管声学话轮结束判断，权重独立下载 | https://huggingface.co/pipecat-ai/smart-turn-v3 ，BSD-2-Clause；完整许可见 `scripts/SMART_TURN_LICENSE`，固定版本与摘要见 `docs/WORLD_MODEL_PLAN.md` |

按用户新要求，本版本提供自部署 OpenMOSS Nano 语音适配器；模型参数与上游代码独立下载，不随本仓库分发。来源和权重摘要见 [架构记录](docs/XIM_MOSS_ARCHITECTURE.md)。不读取旧的 `private/moss.json`，也不使用旧的 `MOSS_*` 云接口配置；私有研究文件和数据不随本仓库分发。

公开语音开发数据 AISHELL-3 来源为 https://www.openslr.org/93 ，页面标注 Apache 2.0；只准备了 30 条格式验证样本，没有训练声音模型。具体角色声音的使用授权需要独立记录。

ChatCut 是独立的视频制作工具，不作为应用运行时依赖。项目自有机器人由程序几何建模；不使用他人的声音克隆。自建代码、开源基础组件、模型权重和数据分别记录归属，产品品牌不替代第三方许可说明。
