# Xim 独立训练计划

v0.9.0 移除 MOSS-TTS-Nano 专用训练脚本。此目录目前只有研究计划；没有可启动完整训练的替代脚本，没有新模型权重。通用数据准备脚本与已经下载的 AISHELL-3 开发样本保留。

## 数据准备

```powershell
python scripts/fetch_aishell3_sample.py --output data/aishell3-sample --per-speaker 10
python scripts/prepare_aishell3.py --root data/aishell3-sample --output data/aishell3-sample-prepared --eval-speakers 1
```

当前产出 20 条训练、10 条未见说话人的留出样本，**仅测试格式与分组**。完整 [AISHELL-3](https://www.openslr.org/93) 约 85 小时、218 人、19 GB，公开页标注 Apache 2.0。样本是中性朗读，不包含自然打断或情绪偏好标签。下载、模型、录音和中间产物留在 Git 忽略目录。

## 三条研发任务

| 目标 | 数据和监督 | 独立评估 |
| --- | --- | --- |
| Xim Turn 轮次策略 | 自愿互动样本：音频时间、转写前缀、已播位置、listen/backchannel/yield/reply 标签；会话不跨集合 | 误抢话、漏接话、停播延迟、否定纠正恢复率 |
| Xim Task 指令模型 | 工具 schema、用户要求、澄清、方案修订、确认和执行结果；拒绝任意命令 | JSON 合法率、对象选择、撤销后不执行、真实任务完成率 |
| Xim Affect 表达 | 公开授权或另行取得授权的角色语音和表达文本；独立的人类偏好评价 | 发音错误、情绪恰当性、自然度、首音延迟、说话人与文本泛化 |

开源基础模型选定后固定代码和权重修订，在隔离环境中准备其实际训练格式；不能把不同架构的标签、音频 token 或检查点直接套用。保留基础模型与业务适配的归属；不采集或蒸馏 MOSS API 输出作为训练集。

每次训练记录数据许可、SHA-256、分组策略、超参数、算力、父 checkpoint；评测不合格时不替换在线版本。当前 Python 3.8 服务器环境须单独处理依赖兼容性，不能据此假称微调完成。候选模型只在完成服务部署和实测后进入产品。
