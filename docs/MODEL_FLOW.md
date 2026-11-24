# Xim Duplex 当前模型与对话流程

更新时间：2026-11-24 · 代码版本：v0.10.0

现行产品不调用第三方云 API。当前主对话链路是 Xim 持续收音 → 自部署 Whisper＋Smart Turn → 两阶段插话控制与有限交互状态 → 明确任务路由或自托管语言模型 → 本地神经语音，服务不可用时回退设备朗读。讲话开始先 hold，附和或未识别可 resume，纠正／让出／新输入才 cancel。实际启用状态与组件实测见[验证记录](VALIDATION.md)。

主对话现在可以接收明确语音口令创建虚拟会议，或把场景动作交给物理工作台；普通聊天、能力提问和否定句不触发任务。工作台与会议空间使用自托管语言模型处理结构化任务，由 Xim 检查方案、确认、对象、坐标和执行状态。完整模型参数、时序与安全边界见 **[语音任务全链路模型细节](VOICE_TASK_PIPELINE.md)**，操作方式见 [使用指南](WORKBENCH_AND_MEETING.md)。

主对话可配置独立文本和声音服务，图像生成改为自部署服务接口；见[部署说明](SELF_HOSTED_ROADMAP.md)。本机已连接服务器的 Nano 语音，图像模型尚未部署。自主研发与训练边界见[技术路线](MODEL_STRATEGY.md)。

```mermaid
flowchart LR
    TALK[语音或文字] --> ROUTE{服务端明确任务路由}
    ROUTE -->|普通聊天| CHAT[本地陪伴对话模型]
    ROUTE -->|明确场景动作| LAB[物理工作台：建物体、下载、虚拟机械臂]
    LAB --> CHECK[动作白名单、当前对象与坐标校验]
    CHECK --> COMPUTE[固定计算：服务器或本机]
    LAB --> IMAGE[用户确认后请求自部署图像服务<br/>未配置时提示不可用]
    ROUTE -->|创建或组织会议| ROOM[会议空间：具名角色与任务]
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
    VAD --> ENDPOINT[Smart Turn v3.2 句尾预测]
    ENDPOINT --> GATE[并行识别后判断接话，未完最多等1400ms]
    ASR --> GATE
    GATE -->|最终文字| TURN[对话事件树<br/>用户意图、父节点、打断状态]
    TEXT --> TURN
    TURN --> CTX[构建上下文<br/>已播放前缀 + 新输入 + 打断信息]
    CTX --> LLM[本地文本模型<br/>整段文本生成]
    LLM --> JSON[解析情绪段落<br/>可读纯文字兼容，破损结构返回失败]
    JSON --> UI[对话气泡与情绪文字色]
    JSON --> PET[Three.js 角色表情]
    JSON --> CHUNK[短段朗读队列，播放时预取下一段]
    CHUNK --> TTS[本地神经语音 / 浏览器朗读回退]
    TTS --> OUT[扬声器 / 耳机]
    TTS -->|boundary / end| ACK[确认播放位置<br/>无 boundary 时按完整短段确认]
    ACK --> TURN
    VAD -->|speech.start| HOLD[两阶段控制：先暂停播放]
    ASR -->|附和 / 未识别| RESUME[续播同一代次]
    ASR -->|纠正 / 让出 / 新输入| STOP[取消旧回答并撤销未播放队列]
    HOLD --> RESUME
    HOLD --> STOP
    RESUME --> CHUNK
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
    participant C as 两阶段控制器
    participant D as 对话状态
    participant L as 自托管语言模型
    participant P as 播放队列
    U->>D: 最近很烦
    D->>L: 用户原话与历史
    L-->>D: 工作让你很累，可以试试……
    D->>P: 排入短段朗读队列
    P-->>D: 确认已播放“工作让你很累”
    U->>V: 嗯嗯 / 不是工作，是家里的事
    V->>C: speech.start
    C->>P: 先 hold，等待语义分类
    alt 附和或未识别片段
        C->>P: resume 同一回答，不创建用户轮次
    else 纠正、让出或新输入
        C->>P: cancel，清空未播放队列
        C->>D: 保留用户意图与已播放前缀
        D->>L: 最新输入 + 已确认上下文
        L-->>D: 按新意图回答
        D->>P: 播放新代次回答
    end
    Note over C,P: 输出代次使旧回调与迟到音频失效
```

这是应用层的对话事件树和规则分类，不是原生端到端双工模型，也不能将用户对话插入模型内部隐藏推理。播放确认是浏览器事件估计，不能精确证明用户听到了哪一个音素。当前分类依赖最终转写，开放扬声器、背景对话、口音和复杂重叠语音仍需独立实测。

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

目前没有达到策略晋级所需的真人数据。独立的 xim-chat-v1 文字多任务后训练已完成首轮试验，见第 5 节；语音模型自进化仍未完成。服务端现已把本地 active 策略文字实际传入聊天请求，策略记录不等于权重更新。

## 4. 创业目标：跨模态融合（尚未训练或集成）

目标架构采用新的语音理解与合成组件，现有级联 Demo 仅作为工程对照；目标与当前实现不得混写。Mimi、xim-chat-v1 与 CosyVoice 2 通过xim 适配层共享语义表示，不把权重直接相加，也不把简单服务串联称为已融合模型。

```mermaid
flowchart TD
    AUDIO[持续用户音频] --> AEC[AEC／降噪／VAD]
    REF[设备播放参考] --> AEC
    AEC --> MIMI[Mimi 用户音频编码器<br/>音频前端 + Transformer + RVQ<br/>仅编码 · 24 kHz · 12.5 Hz · 80 ms]
    MIMI --> PROJ[xim 音频投影层<br/>LayerNorm + MLP]
    PROJ --> ADAPT[xim 时序适配器<br/>因果 Transformer + 有界缓存]
    TEXT[文字／确认转写] --> ALIGN[共享语义表示对齐]
    ADAPT --> ALIGN
    STATE[会话树 + 输出代次 + 播放采样时钟] --> ALIGN
    ALIGN --> XIM[xim-chat-v1 共享语义工作区<br/>Qwen3-8B · 36 层 · LoRA rank 16]
    XIM --> POLICY[xim 六动作分类头<br/>continue · backchannel · hold<br/>yield · correct · repair]
    XIM --> SEG[增量文字与情绪段落]
    SEG --> VPROJ[XimVoiceCond-v1]
    VPROJ --> CV2[CosyVoice 2<br/>FSQ + 文本—语音 LM<br/>chunk-aware causal flow matching]
    CV2 --> PLAY[可取消音频块队列＋固定附和库]
    PLAY --> ACK[按实际播放采样数确认]
    ACK --> STATE
    ACK --> AEC
    ACK --> FACE[表情与情绪色同步]
    POLICY -->|暂停 / 取消 / 恢复| PLAY
    XIM --> PLAN[会议／虚拟场景 ToolPlan 提案]
    PLAN --> CHECK[服务端权限与参数校验]
    CHECK --> STATE
```

候选、证据与边界：

- [Mimi／Moshi](https://github.com/kyutai-labs/moshi)：目标链路只采用 Mimi 用户音频编码器；上游说明为全流式、80 ms 帧级表示。2026-11-23 本机 Windows CPU 独立微基准为 n=10、3.84 秒合成音频编码 P50 3793.193 ms／P95 4765.936 ms；不证明实时、中文语义、重建音质或 LiveBridge 集成。
- **xim 适配层**：音频投影、因果时序适配器、轮次行为头和 XimVoiceCond-v1 都是待训练模块；维度与接口必须按实际模型张量契约实现，不虚构融合参数或检查点。
- [CosyVoice 2](https://github.com/FunAudioLLM/CosyVoice)：FSQ、文本—语音 LM 与 chunk-aware causal flow matching 的合成候选；增量文本、可听首音、自然度、取消与并发均未在 Xim 实测。
- [SpeechTokenizer（ICLR 2024）](https://proceedings.iclr.cc/paper_files/paper/2024/hash/86d1ab582afb247ccaa84bec4a7e24f7-Abstract-Conference.html)：仅作 RVQ 语义／声学解耦对照，不作为原生流式能力证据。
- [Moshi](https://github.com/kyutai-labs/moshi)：仅作独立原生双音频流研究参考，中文效果、许可与算力需独立评估。
- [MOVA 论文](https://arxiv.org/html/2602.08794v2)：同步音视频生成架构，可借鉴时间对齐与跨模态桥接，不是现成的语音对话模型。本项目未加载其权重。

详细融合结构、接口与分阶段训练见 **[融合模型设计](FUSION_ARCHITECTURE.md)**；双工状态与验收定义见 [全双工架构说明](DUPLEX_ARCHITECTURE.md)；逐次结果与限制见 [验证记录](VALIDATION.md) 和 [组件实测](evaluations/2026-11-23/README.md)。

## 5. xim-chat-v1 离线多任务后训练

产品模型名称为 **xim-chat-v1**；基座标明 Qwen3-8B 与固定修订。首轮 SFT 136 步、GRPO 120 步及离线评测均完成。v0.9.4 采用 SFT 检查点，100 条任务完整正确率 94% → 100%；GRPO 未证明额外收益。真实产品开发回归在修复选择别名后通过 11/11，仍需真人语音与更广泛场景验收。

```mermaid
flowchart LR
    BASE[Qwen3-8B<br/>固定版本与逐片校验] --> SFT[LoRA SFT]
    PUBLIC[64条公开中文对话] --> SFT
    TASK[480条合成任务提案] --> SFT
    SFT --> GRPO[GRPO<br/>同题多候选与规则奖励]
    TASK --> GRPO
    GRPO --> TASKTEST[100条隔离任务留出]
    GRPO --> DIALOGUE[16条公开验证对话<br/>NLL与人工审读]
    GRPO --> CONTRACT[真实产品提示与解析器检查<br/>聊天 / 会议 / 工作台]
    TASKTEST --> REVIEW{比较基座与候选<br/>检查退化、截断及奖励方差}
    DIALOGUE --> REVIEW
    CONTRACT --> REVIEW
    REVIEW -->|合格候选| SERVE[显式选择适配器<br/>保留基座和旧版本]
    REVIEW -->|未通过| KEEP[保留在线基线]
```

训练任务的 JSON 提案和主聊天的情绪段落是不同接口；任务分数不能替代产品兼容性检查。GRPO 的可验证任务奖励不是人类情感偏好，也没有训练语音生成或物理世界模型。完整来源和状态见 [xim-chat-v1 模型卡](XIM_CHAT_V1_MODEL_CARD.md)。
