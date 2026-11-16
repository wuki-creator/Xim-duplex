# Xim Duplex 当前模型与对话流程

更新时间：2026-11-16 · 代码版本：v0.9.1

现行产品不调用或微调 MOSS。默认链路是 Xim 收音与打断管理 → 自部署 Whisper → 自托管语言模型 → 设备朗读；三种空间统一使用自己的语音入口。

工作台与会议空间使用自托管语言模型处理结构化任务，由 Xim 检查方案、确认和执行状态。详细操作与验证边界见 [使用指南](WORKBENCH_AND_MEETING.md)。

主对话可配置独立文本和声音服务，图像生成改为自部署服务接口；见[部署说明](SELF_HOSTED_ROADMAP.md)。这些通用接口已经实现，神经语音和图像模型尚未部署。自主研发与训练边界见[技术路线](MODEL_STRATEGY.md)。

```mermaid
flowchart LR
    TALK[语音或文字] --> ROUTE[本地模型识别意图]
    ROUTE --> LAB[物理工作台：建物体、下载、虚拟机械臂]
    LAB --> COMPUTE[固定计算：服务器或本机]
    LAB --> IMAGE[用户确认后请求自部署图像服务<br/>未配置时提示不可用]
    ROUTE --> ROOM[会议空间：具名角色与任务]
    ROOM --> PLAN[讨论及方案版本]
    PLAN --> CONFIRM{用户明确确认}
    CONFIRM --> RESULT[完成文字交付物或获准计算]
```

**状态：可插话的级联原型。Windows 听写在真人测试中失败后，已切换为经 SSH 连接的 Whisper Small；三条合成语音与静音检查通过，用户已确认能识别真实讲话。复杂重叠对话仍待验证。** 下图描述当前这台机器配置的实际链路；目标架构单独列出。

## 1. 当前运行链路

```mermaid
flowchart TD
    U[用户] -->|文字| TEXT[文字输入框]
    U -->|声音| MIC[浏览器麦克风]
    MIC --> CAP[AudioWorklet<br/>单声道 PCM16 · 16 kHz · 50 ms 包]
    CAP --> METER[输入音量与设备诊断]
    CAP --> WS[鉴权 WebSocket<br/>持续输入，朗读时保持收音]
    WS --> VAD[能量 VAD<br/>160 ms 启动 · 700 ms 静音结束]
    FINISH[这句说完了<br/>手动结束当前语句] --> VAD
    VAD -->|按序保留完整语句| TUNNEL[回环接口 + SSH 加密通道]
    TUNNEL --> ASR[服务器 Whisper Small<br/>CPU INT8 · 8 线程 · 整句识别]
    ASR -->|空结果 / 低置信度| FAIL[提示识别失败<br/>保持文字入口]
    ASR -->|最终文字| TURN[对话事件树<br/>用户意图、父节点、打断状态]
    TEXT --> TURN
    TURN --> CTX[构建上下文<br/>已播放前缀 + 新输入 + 打断信息]
    CTX --> LLM[本地文本模型<br/>整段文本生成]
    LLM --> JSON[解析情绪段落<br/>结构异常时重试纯文字]
    JSON --> UI[对话气泡与情绪文字色]
    JSON --> PET[Three.js 角色表情]
    JSON --> CHUNK[短段朗读队列]
    CHUNK --> TTS[可替换本地语音 / 浏览器朗读<br/>当前默认设备声音]
    TTS --> OUT[扬声器 / 耳机]
    TTS -->|boundary / end| ACK[确认播放位置<br/>无 boundary 时按完整短段确认]
    ACK --> TURN
    VAD -->|speech.start| STOP[取消旧回答请求<br/>停止朗读、撤销未播放队列]
    STOP --> TURN
    STOP -.-> LLM
    STOP -.-> CHUNK

    classDef pending fill:#fff3df,stroke:#bc7020,color:#34210c;
    class ASR,FAIL pending;
```

当前机器通过私有配置启用服务器 Whisper Small；模型 revision 为 `536b0662742c02347bc0e980a01041f333bce120`，模型文件已校验 SHA-256。服务端和本机转发端都只监听回环地址，音频经 SSH 传输，不保存原始录音。Windows 听写仍是未配置远程服务时的兼容路径。本机被拦截的 NumPy 未启用。模型替换改善识别入口，但尚未提供流式转写或原生双音频流生成。

## 2. 插话后的上下文如何续接

```mermaid
sequenceDiagram
    participant U as 用户
    participant V as 语音输入 / VAD
    participant D as 对话状态
    participant L as 自托管语言模型
    participant P as 播放队列
    U->>D: 最近很烦
    D->>L: 用户原话与历史
    L-->>D: 工作让你很累，可以试试……
    D->>P: 排入短段朗读队列
    P-->>D: 确认已播放“工作让你很累”
    U->>V: 不是工作，是家里的事
    V->>P: 立即停止并清空未播放队列
    V->>D: 记录被打断的节点与播放位置
    V-->>D: 识别完成后的新输入
    D->>L: 原用户意图 + 已播放前缀 + 新纠正
    L-->>D: 明白，是家里的事……
    D->>P: 播放新分支的回答
    Note over D,P: 旧播放回调失效；未播出的内容不追加进语音历史
```

这是应用层的对话事件树。不能将用户对话插入模型内部隐藏推理。播放确认也是浏览器事件估计，不能精确证明用户听到了哪一个音素。当前能量 VAD 仍无法区分“嗯嗯”等附和与真正打断。

## 3. 当前递归改进范围

```mermaid
flowchart LR
    F[用户勾选授权并主动评价] --> DATA[本地文字反馈]
    DATA --> PROPOSE[至少 10 条负反馈<br/>生成提示策略候选]
    PROPOSE --> EVAL[独立真人对照报告<br/>至少 50 个案例]
    EVAL --> GATE{统计与性能门槛}
    GATE -->|通过| VERSION[保留父版本并晋级]
    GATE -->|未通过| KEEP[保留当前策略]
    VERSION --> F
```

目前没有达到晋级所需的真人数据，也没有进行权重微调。现有闭环只管理提示策略，不能称为已经完成语音模型自进化。

## 4. 拟升级架构：尚未部署

MOSS-Live 路线已通过真实接口的两轮合成音频测试。它不依赖下方自研路线的 ASR、TTS 或轮次模型。

```mermaid
flowchart LR
    MIC[持续麦克风输入] --> LIVE[MOSS-Live 实时会话]
    LIVE -->|字幕快照和最终结果| CHAT[对话气泡]
    LIVE -->|流式 PCM 音频与打断事件| PLAYER[浏览器播放器]
    PLAYER -->|已播完成或已停播时长| LIVE
    PLAYER --> AUDIO[扬声器或耳机]
```

```mermaid
flowchart TD
    AUDIO[持续音频输入] --> AEC[回声处理与目标说话人]
    AEC --> STREAM[中文流式 ASR<br/>临时转写、修订、最终转写]
    STREAM --> TM[语义轮次管理<br/>附和、让出、纠正、恢复、换题]
    TM --> STATE[服务端会话树<br/>播放时间轴与输出代次]
    STATE --> GEN[流式对话生成]
    GEN --> STTS[流式 TTS]
    STTS --> PLAY[可取消音频块队列]
    PLAY --> ACK[按实际播放采样数确认]
    ACK --> STATE
    ACK --> FACE[表情与情绪色同步]
    TM -->|必要时暂停 / 取消| PLAY
    RESEARCH[研究分支：Moshi 类原生双音频流模型] -.替换级联核心.-> GEN
```

候选与依据：

- [FunASR](https://github.com/modelscope/FunASR)：中文流式识别候选，待部署与真实音频验证。
- [CosyVoice](https://github.com/FunAudioLLM/CosyVoice)：流式文本输入/语音输出候选，待验证设备端延迟。
- [Moshi](https://github.com/kyutai-labs/moshi)：用户/助手双音频流架构参考，中文效果与算力需独立评估。
- [MOVA 论文](https://arxiv.org/html/2602.08794v2)：同步音视频生成架构，可借鉴时间对齐与跨模态桥接，不是现成的语音对话模型。本项目未加载其权重。

详细改造、训练与验收设计见 [全双工架构说明](DUPLEX_ARCHITECTURE.md)；实测与限制见 [验证记录](VALIDATION.md)。
