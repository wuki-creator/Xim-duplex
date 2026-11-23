# 独立识别服务部署

当前部署采用 Linux CPU Whisper Small → SSH 加密转发 → 本机 Node 服务。模型与音频不进入 GitHub；账号、地址保存在本机忽略目录，密码只在进程内使用。没有修改系统应用控制策略，也没有对外开放 ASR HTTP 端口。

## 服务端

在有可用空间的用户目录创建隔离环境，安装 `requirements-asr.txt`。旧 Python 3.8 环境的实测组合为 faster-whisper 1.0.3 / CTranslate2 4.4.0，使用独立依赖目录，不覆盖系统环境。新部署推荐受支持的 Python 版本。

上传 `scripts/asr_worker.py`，从 [Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small) 获取权重。当前 revision：`536b0662742c02347bc0e980a01041f333bce120`；model.bin SHA-256：`3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671`。包含 config.json、tokenizer.json、vocabulary.txt，按下载清单校验文件。

```bash
ASR_ENGINE=whisper ASR_MODEL=/absolute/path/to/model-small \
ASR_MODEL_LABEL=Whisper-small ASR_DEVICE=cpu ASR_COMPUTE_TYPE=int8 \
ASR_THREADS=8 ASR_PORT=18792 python scripts/asr_worker.py
```

进程只监听 `127.0.0.1:18792`。生产使用应由用户自己的进程管理器负责重启；目前部署为独立后台进程，不能承诺服务器重启后自动恢复。不要占用系统盘不足的目录，不自动安装到全局 Python，也不抢占共享 GPU。

## 本机

安装 Paramiko，确保 SSH 主机密钥已通过正常方式确认并加入 `~/.ssh/known_hosts`。启动：

```powershell
python scripts/ssh_asr_tunnel.py --host <你的服务器> --user <你的账号>
```

默认将本机 `127.0.0.1:18791` 转发到远端 `127.0.0.1:18792`。`--background` 可启动隐藏后台进程；密码通过子进程环境传入后立即从环境删除，不写入命令行或文件。连接断开后需重建，不保存可自动重连的密码。

可在 Git 忽略的 `private/asr.json` 中写入：

```json
{
  "url": "http://127.0.0.1:18791",
  "ssh": {"host": "你的服务器", "user": "你的账号", "ssh_port": 22, "local_port": 18791, "remote_port": 18792}
}
```

`Start_Voice.ps1` 会读取这份独立配置。Node 读取识别地址的优先级是 `ASR_URL` → 此私有配置 → 本机默认端口 8791。首次修改配置后重启 Node。检查 `/api/bootstrap` 的 `asrReady` 与 `asrModel`，再进行真实讲话测试。

## 范围与验收

当前仍为整句 ASR，不能称为流式识别；转发链路不落盘原始录音。已验证三个合成中文短句和静音，单次延迟约 1.1–1.5 秒，不是 P95 或人群准确率。用户随后确认真实讲话可以被识别。仍需覆盖轻声、回声、口音及重叠发言，不能由一次基础成功推断完整交互质量。
