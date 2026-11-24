"""Keep the installed recognizer warm, without downloading native binaries."""
import base64, json, os, queue, shutil, subprocess, threading
from pathlib import Path

def simplified_chinese(text):
    """Normalize Whisper Chinese captions before matching Mandarin task commands."""
    import ctypes
    if not text:
        return text
    # LCMapStringW counts UTF-16 code units, including the terminator for -1.
    convert = ctypes.windll.kernel32.LCMapStringW
    size = convert(0x0804, 0x02000000, text, -1, None, 0)
    if size:
        output = ctypes.create_unicode_buffer(size)
        if convert(0x0804, 0x02000000, text, -1, output, size):
            return output.value
    return text


class WindowsASR:
    def __init__(self): self.process=None;self.start()
    def start(self):
        if self.process and self.process.poll() is None:self.process.terminate()
        shell=os.environ.get('ASR_POWERSHELL') or shutil.which('pwsh') or 'powershell.exe'
        self.process=subprocess.Popen([shell,'-NoProfile','-NonInteractive','-File',str(Path(__file__).with_name('transcribe_windows.ps1'))],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
        self.messages=queue.Queue();messages=self.messages;process=self.process
        def read():
            for line in process.stdout:messages.put(line)
            messages.put('{"error":"recognizer_exited"}')
        threading.Thread(target=read,daemon=True).start()
        try:
            if json.loads(messages.get(timeout=18)).get('ready') is not True:raise RuntimeError('Windows zh-CN speech recognition is unavailable')
        except Exception:
            process.terminate();raise
    def transcribe(self,raw):
        if self.process.poll() is not None:self.start()
        try:
            self.process.stdin.write(base64.b64encode(raw).decode('ascii')+'\n');self.process.stdin.flush()
            result=json.loads(self.messages.get(timeout=16))
            if 'error' in result:raise RuntimeError(result['error'])
            return {"text":result['text'],"reason":result.get('reason')}
        except Exception:
            self.process.terminate();raise
