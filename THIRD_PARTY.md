# 第三方组件

| 组件 | 使用方式 | 来源与许可 |
| --- | --- | --- |
| Three.js 0.187.0 | 浏览器三维机器人，随仓库分发 | https://github.com/mrdoob/three.js ，MIT；保留 `public/vendor/three-LICENSE.txt` |
| ws 8.23.0 | Node WebSocket | https://github.com/websockets/ws ，MIT；通过 npm 安装 |
| faster-whisper | 语音识别服务；当前旧 Python 服务器使用 1.0.3 / CTranslate2 4.4.0，本机依赖清单为 1.2.1 | https://github.com/SYSTRAN/faster-whisper ，MIT；独立安装 |
| Whisper Small / CTranslate2 模型 | 当前服务器识别权重，单独下载，不随仓库分发 | https://huggingface.co/Systran/faster-whisper-small ，按模型卡与上游许可使用；兼容 tiny 配置 |
| Paramiko | SSH 加密转发，独立安装 | https://github.com/paramiko/paramiko ，按上游许可使用；本仓库不分发其包 |
| DeepSeek | 服务端 API | https://api-docs.deepseek.com ，须使用有权限的账号；无权重分发 |
| 系统语音合成 | 浏览器 SpeechSynthesis | 声音可用性与服务条款由浏览器/系统决定 |

MOSI/OpenMOSS 在本版本为方案研究与可替换模块候选，没有复制或训练其未公开权重。ChatCut 是独立的视频制作工具，不作为应用运行时依赖。项目自有机器人由程序几何建模；不使用他人的声音克隆。
