# xim-chat-v1 多任务训练与验证

模型产品名称统一为 **xim-chat-v1**。这是基于 Qwen3-8B 的多任务适配器候选名称，阶段用 `sft` / `grpo` 区分；命名不改变第三方来源和当前训练状态。服务部署时使用 `--model-name xim-chat-v1`，同时通过健康接口保留基座与适配器信息。

更新：2026-11-16。**当前状态：pending。** 数据、奖励验证器及隔离训练环境已就绪，A100 上 BF16 运算与全部训练样本的真实分词检查通过；Qwen3-8B 权重仍在下载。本文不代表已完成训练、已产生可用适配器或已提升线上体验。训练结束后以对应 `run_manifest.json`、检查点与评估报告更新状态。[模型卡](../docs/XIM_CHAT_V1_MODEL_CARD.md)保留产品名称、基座和发布状态。

## 这次实际训练什么

基础模型是 [Qwen/Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B/tree/b968826d9c46dd6066d109eabc6255188de91218)，固定 revision 为 `b968826d9c46dd6066d109eabc6255188de91218`，许可 Apache-2.0。该模型实际包含 **8,190,735,360 个参数**；“8B”是规模名称，不能把它写成 6B 或 10B。下载器校验各权重分片 SHA-256，训练时另记录实际参数数目及所加载权重哈希。

本轮是单卡 **LoRA SFT → GRPO 小规模验证**，不是从头训练或全参数训练。默认 LoRA 在 `q_proj`、`v_proj` 上使用 rank 16、alpha 32、dropout 0，冻结基础权重。默认 SFT 20 个更新步，随后 GRPO 8 个更新步；这是工程验证用的短训练，不是完整数据集训练完成的声明。`--lora-targets all-linear` 可显式扩大 SFT 适配范围，但不属于默认配置。

服务器首轮实验预先固定为 SFT **136 步**（544 条、batch 1、累积 4，一遍输入）→ GRPO **120 步**（每题 4 个候选），通过 `run_experiment.py` 运行。它逐片校验固定上游 SHA，检查数据计数与摘要，等允许的单卡达到空闲阈值后开始，逐阶段保存日志并在失败时停止，不自动上线。此处是预先登记的配置，当前尚无真实 8B 完成记录；不先看 100 条留出再选步数。120 步 GRPO 约对应 120 个独立提示和 480 个候选，实际参与任务及奖励方差由 `reward_audit` 记录。

任务是会议人数、场景动作、接受纠正、让话以及机械臂轨迹**提案**。纠正和让话只监督结构化状态决策，不使用“开心词”、回答长度或虚构的人类偏好作为奖励。MOSS Nano 语音合成参数、Smart Turn 参数及线上对话模型均不由这些脚本自动替换。

## 数据、来源与隔离

| 数据 | 本轮用途 | 当前数量 | 固定来源与许可 |
| --- | --- | --- | --- |
| OASST2 中文对话 | SFT；只取来源审核通过、非 synthetic、rank 0 的短回复，每棵对话树最多一个目标 | 训练 64；官方验证集 16 | [OpenAssistant/oasst2](https://huggingface.co/datasets/OpenAssistant/oasst2/tree/179dd21fc55192153d94adb0e0ce8f69e222bf75)，revision `179dd21fc55192153d94adb0e0ce8f69e222bf75`，Apache-2.0 |
| Xim 模板任务 | SFT 与可验证奖励 GRPO | 训练 480；留出 100，五类任务各 96 / 20 | `make_multitask_data.py` 生成，全部标记 `synthetic: true`，不是人类偏好或真实物理轨迹 |
| HelpSteer3 中文偏好 | 已下载并清理，**不用于本轮 SFT / GRPO**；留待单独的偏好学习方案 | 训练 1,780；验证 111 | [nvidia/HelpSteer3](https://huggingface.co/datasets/nvidia/HelpSteer3/tree/f6d145777bcbde96137596340fab89793acd1031)，revision `f6d145777bcbde96137596340fab89793acd1031`，CC-BY-4.0，保留来源署名与修改记录 |
| ToolACE | 已下载审查，本轮未选入 | 0 条进入训练 | [Team-ACE/ToolACE](https://huggingface.co/datasets/Team-ACE/ToolACE/tree/6bda777c88d21e5a204703c1ee45597a8fa4f734)，revision `6bda777c88d21e5a204703c1ee45597a8fa4f734`，Apache-2.0；本身是合成工具对话 |

HelpSteer3 的候选回答由模型生成，偏好对比标注来自人；不能把两者都说成人类原创。中文训练集移除了与验证提示重叠的 121 条记录，保留 1,780 条非平局配对。离线偏好配对也不等于已经进行了在线强化学习。

本轮 SFT 输入共 **544 条 = 480 条合成任务 + 64 条公开中文对话**，已合并到 `data/multitask-sft-v1/train.jsonl`。GRPO 仅使用有 `case.expected` 的 480 条合成任务。公开自然对话没有确定的结构化目标，不能硬套任务奖励。

数据证据保存在 Git 忽略目录：

- `data/multitask-public/manifest.json`：原始下载文件、固定 revision、SHA-256、许可、来源模型卡和 HelpSteer3 清理计数。
- `data/multitask-public/public-sft-manifest.json`：64 / 16 条中文样本筛选与官方验证树隔离证据。
- `data/multitask-synthetic-v1/manifest.json`：生成器、样本计数、文件 SHA-256 与切分边界。
- 训练生成的 `run_manifest.json`：实际合并输入的 SHA-256、训练记录 ID、分组 ID、来源及父适配器。原始下载清单不是训练完成记录。

OASST2 按官方验证树 ID 隔离；验证树的任何分支均不进入训练。合成留出采用不同模板、主题、物体 ID 范围和坐标域：训练坐标为整数，留出为半整数。两者无重复提示哈希，但仍共享任务和输出 schema，因此只检验有限的模板泛化，不能称为未见任务或真人评测。100 条任务留出和 16 条公开验证均不用于本轮训练；不要通过反复查看留出结果调参。

需要从已校验的本地原始文件重建时，在仓库根目录运行：

```bash
python training/make_multitask_data.py --output data/multitask-synthetic-v1
python training/prepare_public_sft.py --root data/multitask-public --train-limit 64 --validation-limit 16 --max-chars 800
```

第二条命令要求原始 OASST2、ToolACE 及官方验证树证据已存在。首次提取验证树可显式加 `--fetch-validation-ids`，这一步需要 PyArrow 并下载固定版本验证文件；正常训练不会联网获取数据。

## 算力与显存边界

服务器容量快照为 **8 × NVIDIA A100 80 GB**。这是硬件信息，不是八张卡已分配给本项目。当前脚本只允许一个进程、显式选择的**一张 GPU**，不进行八卡分布式训练；开始前重新检查该卡显存和现有任务，不以“空闲快照”当作预留。

全参数混合精度 Adam 的一种常用静态估算是约 **16 bytes / parameter**：低精度权重与梯度各约 2 bytes、FP32 主权重约 4 bytes、两个优化器状态约 8 bytes。具体实现可能不同，此处只是容量估算：

| 参数规模 | 按 16 bytes / parameter 的静态状态估算 | 尚未计入 |
| --- | --- | --- |
| 6B | 96 GB，约 89.4 GiB | 激活、注意力临时量、通信缓冲、生成缓存、内存碎片等 |
| 本次 8,190,735,360 | 约 131.1 GB，122.1 GiB | 同上 |
| 10B | 160 GB，约 149.0 GiB | 同上 |

上表**不适用于直接估算 LoRA**。本次冻结基础权重，仅 BF16 基座约 16.4 GB；仍需额外容纳适配器参数和优化器、激活、生成缓存及 GRPO 多候选生成。不能用权重大小保证训练显存足够，实际峰值由运行记录给出。当前 GRPO 禁用 vLLM，不另起推理副本；KL 参考是关闭适配器后的冻结基座，不是另加载的 SFT 参考模型。

## 环境与运行命令

使用独立 Python 3.11 环境，固定依赖见 `requirements-training.txt`：PyTorch 2.6.0、Transformers 4.57.1、TRL 0.23.1、PEFT 0.17.1、Accelerate 1.10.1。训练器会检查关键版本、BF16 能力和单卡可见性。安装时匹配服务器驱动与 CUDA 构建，不覆盖正在提供语音/对话服务的环境。

以下是 Linux 命令示例，需先将变量设为已准备的绝对路径，并在包含 `training/`、`scripts/` 的工作目录运行。输出目录必须为空或不存在，脚本拒绝覆盖已有训练产物。

```bash
export XIM_TRAIN_ROOT="/absolute/path/to/isolated-training"
export XIM_TRAIN_GPU="已检查可用的单卡编号"
export CUDA_VISIBLE_DEVICES="$XIM_TRAIN_GPU"
export XIM_MODEL_DIR="$XIM_TRAIN_ROOT/qwen3-8b"
export XIM_SFT_DATA="$XIM_TRAIN_ROOT/data/sft-train.jsonl"
export XIM_TASK_DATA="$XIM_TRAIN_ROOT/data/task-train.jsonl"
export XIM_HOLDOUT="$XIM_TRAIN_ROOT/data/task-holdout.jsonl"
python scripts/training_preflight.py --disk-path "$XIM_TRAIN_ROOT"
```

路径对应的输入分别应是上述 544 条 SFT、480 条任务训练及 100 条任务留出文件。预检只读硬件与依赖，不保留 GPU、不启动训练。

下载器是独立的准备步骤；必须等它完整退出成功并逐片校验后才能训练。中途出现 `download-manifest.json` 不代表全部分片已下载：

```bash
python scripts/fetch_training_base.py --destination "$XIM_MODEL_DIR"
```

默认 SFT pilot：

```bash
python training/train_multitask.py --stage sft \
  --model-dir "$XIM_MODEL_DIR" --data "$XIM_SFT_DATA" \
  --output "$XIM_TRAIN_ROOT/runs/sft-pilot" --max-steps 20
```

只在 SFT 的 `run_manifest.json` 为 `completed`、实际更新步数大于零且适配器检查点存在后，继续 GRPO：

```bash
python training/train_multitask.py --stage grpo \
  --model-dir "$XIM_MODEL_DIR" --data "$XIM_TASK_DATA" \
  --sft-adapter "$XIM_TRAIN_ROOT/runs/sft-pilot" \
  --output "$XIM_TRAIN_ROOT/runs/grpo-pilot" --max-steps 8 \
  --num-generations 4 --gradient-accumulation-steps 4 --beta 0.04
```

默认总序列上限 1,024 tokens，GRPO 完成长度上限 192，单设备 batch 为 1，梯度累积为 4；超长输入直接报错，不静默截断目标。SFT 默认学习率 `1e-4`，GRPO 为 `5e-6`。使用 BF16、梯度检查点，关闭 thinking，训练离线加载权重、关闭外部实验上报，不自动发布检查点。20 / 8 步不会覆盖完整训练规模，不能由数据文件总量推断全部记录都参与了更新。

## 奖励与真实提升的区别

`multitask_rewards.py` 只读数据行中的 `case.expected`；completion 不能改写标准答案、权限或评分。目标、枚举、坐标与对象存在性均可验证：

- 精确正确的合法结构目标得 1；合法但参数不符得 0.25。
- 无效 JSON、缺字段、不支持的枚举或缺少有效标准答案得 0。
- 越权执行、伪造批准、请求任意命令/URL 或在答案中注入 reward/score 得 -1。
- 机械臂目标必须保持 `action: propose`、`job: arm`、`execute: false`；坐标正确不等于轨迹可达或已执行。

该分数是规则任务奖励，不是“开心度”或真人偏好。GRPO 对同一提示采样多个候选；若组内奖励标准差为 **0**，这些候选没有相对优劣信号，任务 advantage 为零。由于本轮 `beta > 0`，模型仍可能仅因 KL 正则发生参数变化。因此 `parameters_changed: true`、非零梯度、loss 下降或训练正常退出，都不能单独证明任务能力提升。应结合组内奖励差异、KL、逐任务留出表现和退化情况判断。[TRL 0.23.1 GRPO 说明](https://huggingface.co/docs/trl/v0.23.1/grpo_trainer)

## 对照评估与晋级

评估脚本会加载同一基础权重、同一提示和相同确定性解码，分别关闭与启用候选适配器；检查训练与留出的样本 ID、分组 ID 不重叠。下面不加 `--limit`，评估全部 100 条任务留出：

```bash
python training/evaluate_multitask.py \
  --model-dir "$XIM_MODEL_DIR" --adapter "$XIM_TRAIN_ROOT/runs/grpo-pilot" \
  --holdout "$XIM_HOLDOUT" --output "$XIM_TRAIN_ROOT/reports/grpo-holdout.json"
```

也可将 `--adapter` 指向 SFT 检查点、使用新的输出文件，获得基座与 SFT 对照。报告记录 JSON 格式率、合法动作率、参数正确率、平均奖励、截断率、生成耗时与逐任务结果。它比较的是文本提案，未执行外部操作。16 条公开自然对话验证没有 `case.expected`，**不能直接交给此规则任务评估脚本**；其语言质量和事实性需要单独检查。

每次训练留下 `run_manifest.json`、`adapter_config.json`、`adapter_model.safetensors` 和训练状态；manifest 包含实际步数、基础与适配器哈希、数据哈希、选中 GPU、实际可训练参数量、参数变化和峰值显存。文件存在但状态不是 `completed`，不能称作训练完成。验证脚本、训练日志与小样本留出分数不等于真人语音验收；没有明确通过对照评估、自然讲话与回归检查时，不自动替换线上模型。

## 尚未完成的模型工作

本轮没有训练声学编码器、MOSS 情绪适配器、Smart Turn、端到端全双工语音模型或真实世界模型。现有交互状态层是有界观测与规则建议；机械臂坐标提案只是任务生成，没有学习动作后的物理状态转移。真正的世界模型仍需观测—动作—下一状态轨迹、独立场景留出、预测误差与闭环任务评估。

`xim_moss_adapter.py` 是可选的语音条件残差原型，目前没有由本轮训练得到的声音适配参数。现有 AISHELL-3 开发样本的 20 条训练、10 条留出仍只用于音频格式调试，不能当作足够的情绪或自然打断训练集。声音角色授权、真人偏好、扬声器回声、真人相互打断和语音首音延迟分别验证；不从文本任务分数外推这些能力。
