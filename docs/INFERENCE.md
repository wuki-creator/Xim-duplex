# 全链路推理公式

以下分成 **A．当前可运行级联**、**B．已经实现的语音条件张量计算**、**C．尚未接入的目标融合链路**。A 是现有产品服务的推理过程；B 已通过合成张量契约测试，但使用随机初始化模块；C 只有目标公式，不能当成真实端到端结果。

## A．当前可运行级联：音频 → 文字／任务 → 播放

1. **PCM 归一化与能量 VAD**：浏览器以 16 kHz、单声道 PCM16 采集音频，每 50 ms 一帧，即 `N=800` 个采样点。对原始整数采样 `x_raw[n]`，每帧先累加平方和，再统一归一化。

   ```text
   RMS_t = sqrt((1/N) · Σ_(n=1..N) x_raw[n]²) / 32768
   ```

   `RMS_t ≥ 0.012` 累计 160 ms 后启动语句；启动后 `RMS_t < 0.8×0.012` 累计 700 ms，或语句达到 14 秒，则结束并提交。起音前用 25,600 字节的环形缓冲保留最近 800 ms，触发时从最早采样起读出。

2. **Smart Turn 话尾概率**：服务截取最后 `128000` 个采样点（8 秒），不足时左侧补零，再经过 Whisper 特征提取器和已导出的 ONNX 分类模型。

   ```text
   x_8s      = LeftPadOrLastN(x, 128000)
   F_turn    = WhisperFeatureExtractor(x_8s)
   p_complete = TurnONNX(F_turn)                    # 标量，范围 [0,1]
   complete  = (p_complete > 0.5)
   ```

   它只预测声学话轮是否完成，不生成转写；失败时回退到既有 VAD 语句边界。

3. **Whisper Small 语音识别**：对 VAD 给出的完整语句 `x_utt`，音频编码器产生隐藏表示，文本解码器自回归计算 Token 条件分布。用 `Decode` 表示服务实际采用的解码过程，而不把它简化成已证实的贪心搜索。

   ```text
   H_audio = WhisperEncoder(x_utt)
   p(y_i | x_utt,y_<i) = WhisperDecoder(y_<i,H_audio)
   y = Decode_whisper(Π_i p(y_i | x_utt,y_<i))
   ```

   输出 `y` 是整句文字。当前没有从该模块得到流式字词时间戳或端到端语义工具权限。

4. **会话状态、双工门控与任务路由**：已确认转写、历史、已完整播完的文本块前缀和当前输出代次组成有界状态 `S_t`；话尾概率、插话类别和播放相位经确定性门控得到 `g_t`。

   ```text
   S_t = BoundedHistory(y_≤t, playback_ack_≤t, generation_id, task_state)
   g_t = Gate(p_complete, interruption_intent, playback_phase)
       ∈ {continue, hold, resume, cancel}
   r_t = RouteVoiceTask(y_t,S_t)
       ∈ {chat, meeting, workbench, simple_action}
   ```

   `cancel` 使未播放的旧代音频失效；只有实际播放确认的前缀进入共享历史。路由函数是规则，不是另一个语言模型。

5. **xim-chat-v1 自回归语言推理**：普通聊天、会议和复杂场景提示分别构造 Token 序列，但共用 Qwen3-8B 的 36 层解码器。对任一 Transformer 层，标准计算可写为：

   ```text
   Q = RoPE(H·W_Q)，K = RoPE(H·W_K)，V = H·W_V
   Attn(H) = softmax(Q·Kᵀ/√d_k + M_causal)·V
   H'      = H + Attn(LN(H))
   H_next  = H' + FFN(LN(H'))
   p(z_i | z_<i) = softmax(W_U·H_36)
   ```

   当前 SFT 适配器在 `q_proj、v_proj` 上使用 LoRA rank `r=16`、alpha `32`，对应缩放 `α/r=2`。对其中一个被适配投影，推理时冻结基座并加上低秩增量：

   ```text
   W_eff = W_frozen + (α/r)·B·A
   H_out = H·W_eff
   ```

   主聊天按 `temperature=0.65` 从上述条件分布采样，`max_tokens=320`、非流式；会议和工作台分别使用各自的 JSON 提示及 Token 上限。文本解析与权限校验在模型外执行：

   ```text
   J = ParseAndValidate(z_1:T)
   chat: J = {segments[{text,emotion}]}，最多 6 段、总计不超过 1600 字
   task: J → SchemaCheck → AllowlistCheck → Confirmation（适用时）
   ```

   模型自由生成的 `tool_calls`、shell、URL 或未列出动作不会因此获得执行权限。

6. **当前语音输出与播放反馈**：每个已校验文字段连同允许的情绪标签交给当前本地神经语音接口，返回有界 WAV；失败时才使用设备朗读回退。

   ```text
   wav_k = LocalTTS(text_k,voice,emotion_k)          # 当前级联，非下方目标适配链
   a_k[n] = DecodeWAV(wav_k)
   heard_offset = chunk.end   # 收到当前代次的播放结束回调时更新
   heard_prefix = reply[:heard_offset]
   ```

   WAV 接口限制为 4,000,000 字节。播放队列在整块结束后确认该块的文本偏移。中途取消保留上一完整块的偏移，逐采样播放时钟仍是目标架构的一部分。

7. **会议与虚拟物理场景的执行计算**：模型只提出候选 `a_t`，服务端结合当前场景／会议版本校验后执行。

   ```text
   a_valid = ValidateAction(a_t,current_objects,allowed_actions,coordinate_bounds)
   result  = Execute(a_valid,confirmed_version)
   S_scene,t+1 = ThreeJS_CannonES(S_scene,t,a_valid)
   q_target = ThreeJointIK(position_target)
   trajectory = SmoothSample(q_start,q_target,37)
   ```

   自由落体开发计算忽略空气阻力：`t_hit=sqrt(2h/g)`、`v_hit=g·t_hit`。Three.js、Cannon ES 和逆运动学求解器都不是 LLM；这里只影响浏览器虚拟场景，不控制实体机械臂。

## B．语音条件张量计算：语义 → 896 维条件 → 上游输入

本部分对应已经实现的 [XimVoiceCond-v1](../training/xim_voice_cond.py) 和 [CosyVoice 2 条件适配层](../training/xim_cosyvoice2_bridge.py)。**当前计算入口是调用方提供的语义张量，不是已经接通的 Mimi／xim-chat-v1 隐藏状态。** 契约测试使用随机初始化的模块和合成张量；下列公式说明代码怎样计算，不代表语音训练或官方权重推理已经完成。

设批大小为 `B`、文本 Token 数为 `T`。默认语义输入为 `X ∈ R[B,T,4096]`，情绪、授权音色和状态 ID 分别为 `e、s、u ∈ Z[B]`，每个 Token 的单调非减块号为 `chunk_id ∈ Z[B,T]`。

1. **语义输入投影**：先线性映射到 512 维，再做 LayerNorm。

   ```text
   H0 = LayerNorm(Linear_4096→512(X))                  # [B,T,512]
   c  = concat(E_emotion(e), E_speaker(s), E_state(u)) # [B,256]
   ```

   三类嵌入分别为 64、128、64 维，拼接后的条件向量 `c` 为 256 维。

2. **四层块因果 Transformer**：第 `l` 层先对 `H_l` 做 Pre-LN、RoPE 多头注意力和输出投影得到 `A_l`，再将该层的 FiLM 参数作用于注意力结果。可见性由 `chunk_id` 和布尔掩码共同决定。

   ```text
   A_l    = MHA_RoPE(LN1(H_l), past_KV, block_causal_mask)
   allow(i,j) = (chunk_id[j] <= chunk_id[i]) AND key_padding_mask[j]
   H_l'   = H_l + Dropout(A_l * (1 + scale_l(c)) + shift_l(c))
   H_l+1  = H_l' + Dropout(FFN_512→2048→512(LN2(H_l')))
   ```

   同一前向调用的四层查询和键共用按当前 Token 位置计算的一组正余弦系数。8 个注意力头各自处理 64 维。当前块内部可以双向注意，跨块只能读取当前及过去块。增量计算把每层的 K、V、块号和位置写入缓存；每次调用必须给出完整且严格更新的块，累计长度不得超过 256 Token。

3. **语音条件与辅助韵律输出**：对最后一层隐藏状态 `H` 同时计算残差分支和两层 MLP 分支，归一化后产生 896 维条件；独立预测头输出三个辅助值。无效填充位置最后乘以零掩码。

   ```text
   C = LayerNorm(Linear_512→896(H) + MLP_512→1024→896(H)) * attention_mask
   P = MLP_512→256→3(H)                                      * attention_mask
   # C: [B,T,896]；P: [B,T,3]，依次对应时长／基频／能量辅助预测
   ```

   `P` 是训练监督候选，不是已接入合成器的三个实时控制参数。跨代输出还需经过 `pack_condition_chunk`：只有 `generation_id` 等于当前代次的块才会保留。

4. **目标文本嵌入的条件残差**：进入上游适配层时使用 batch 1。文本 Embedding 分别计算提示文本 `P_text` 和目标文本 `T_text`，条件 `C` 经 LayerNorm、`tanh` 和可训练标量门控 `α` 后只加到目标文本上。

   ```text
   P_text = Embed_text(prompt_text)                    # [1,Tp,896]
   T_text = Embed_text(text)                           # [1,T,896]
   R      = tanh(LayerNorm(C)) * condition_mask         # [1,T,896]
   T_cond = T_text + α · R                             # [1,T,896]
   ```

   `α` 初始化为 0，所以未训练时严格有 `T_cond = T_text`。测试显式设置非零 `α`，确认只有目标文本区间发生变化。

5. **构造上游语言模型输入**：从官方属性链读取 `sos`、`task_id` 和提示语音 Embedding，保持官方非流式拼接顺序。

   ```text
   S_prompt = Embed_speech(prompt_speech_token)         # [1,Ts,896]
   lm_input = concat(sos, P_text, T_cond, task_id, S_prompt, dim=1)
   L        = 1 + Tp + T + 1 + Ts
   # lm_input: [1,L,896]；提示文本、任务标记和提示语音均未加条件残差
   ```

6. **计算有界生成预算并调用上游入口**：默认 `sampling=25`、`min_token_text_ratio=2`、`max_token_text_ratio=20`。代码先按文本长度计算上下限，再应用可选的硬上限。

   ```text
   min_len = int(T * min_token_text_ratio)
   max_len = int(T * max_token_text_ratio)
   max_len = max(1, min(max_len, max_tokens))  # 仅在提供 max_tokens 时取 min
   min_len = min(min_len, max_len)
   tokens  = inference_wrapper(lm_input, sampling, min_len, max_len, uuid)
   ```

   官方入口按 batch 1 顺序处理样本。当前 dry-run 的接口替身只返回确定性的有界整数序列，用于检查调用和张量契约；**这些整数不是经官方 CosyVoice 2 权重生成并验收的 FSQ 语音 Token**。后续 Flow Matching、声码器、波形、首音、RTF、自然度和取消成本均不在本轮 dry-run 的计算范围内。

## C．目标融合链路：持续音频 → 共享语义 → 自回归语音 Token → 波形

以下是目标模型的推理公式，**尚未完成跨模态训练或真实集成**，不能与前两节的现有代码证据混合计算延迟或效果。

1. **Mimi 音频表示与共享语义对齐**：目标输入重采样到 24 kHz，经 Mimi 音频前端、Transformer 和 RVQ 得到带时间戳的音频表示；xim 音频投影层和因果时序适配器再将它与文字、播放及任务状态对齐。

   ```text
   Z_audio = MimiEncoder_RVQ(Resample(x,24000))       # 12.5 Hz，80 ms／帧
   A_t = TemporalAdapter(MLP(LayerNorm(Z_audio≤t)),
                         EmbedText(y≤t),S_t,past_KV)
   H_t = XimChatSharedWorkspace(A_t,text_tokens,S_t)
   ```

   `TemporalAdapter` 只读取当前和过去音频。当前尚未实现从 Mimi 到 xim-chat-v1 的可训练投影检查点，也没有把 `H_t` 自动送入 B 部分。

2. **共享语义的语言、轮次、工具与语音条件分支**：同一个语义工作区分别产生回复 Token、六动作轮次分布、受限任务提案，以及 B 部分所需的语义输入。

   ```text
   z_reply ~ p_xim-chat(z_reply | H_t)
   p_turn  = softmax(W_turn·H_t + b_turn)              # 六动作，NOT_TRAINED
   a_plan  = ParseAndValidate(z_reply)                   # 仍需外部权限校验
   C = XimVoiceCondV1(X_semantic,e,s,u,chunk_ids)        # B 部分，[1,T,896]
   ```

3. **CosyVoice 2 自回归语音 Token 推理**：将 `C` 按 B 部分注入目标文本 Embedding，形成 `lm_input`，上游文本—语音 LM 逐 Token 计算条件分布。

   ```text
   lm_input = BuildLMInput(sos,prompt_text,T_cond,task_id,prompt_speech)
   p(q_i | q_<i,lm_input) = softmax(Qwen2LM(lm_input,q_<i))
   q_1:K = BoundedAutoregressiveDecode(p,min_len,max_len,sampling)
   ```

   `q_1:K` 是目标 FSQ 语音 Token 序列。当前只验证了入口签名、形状和预算，没有加载官方权重计算这个条件分布。

4. **Flow Matching 与声码器波形解码**：目标链路用语音 Token 及上游声学条件约束速度场，沿连续时间变量 `τ` 对潜在表示积分，再由上游声码器得到波形。下面用通用 ODE 形式表示，具体条件、采样器和边界以固定上游实现为准。

   ```text
   dz/dτ = v_flow(z,τ | q_1:K,acoustic_context)
   z_speech = ODESolve(v_flow,z_initial,τ_start→τ_end)
   a[n] = Vocoder(z_speech)[n]
   ```

   目标产品闭环因此可概括为：

   ```text
   x → Mimi／投影／时序适配 → H_t → xim-chat-v1
                                  ├→ 回复／轮次／受限任务
                                  └→ XimVoiceCond-v1 → 文本嵌入残差
                                     → CosyVoice 2 AR Token
                                     → Flow Matching → Vocoder → a[n]
   a[n] → 实际播放采样反馈 → S_t+1 → 下一轮持续输入
   ```

   **C 部分没有真实推理结果**：尚未测量这条链路的真实语音 Token 质量、波形、首音、RTF、自然度、CER、音色一致性、AEC 或真人全双工指标。
