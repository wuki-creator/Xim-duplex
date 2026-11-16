# Warm installed Windows recognizer: JSON replies and base64 PCM lines on stdio.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$engine=New-Object System.Speech.Recognition.SpeechRecognitionEngine([Globalization.CultureInfo]'zh-CN')
$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
[Console]::WriteLine('{"ready":true}')
try {
 while($null -ne ($inputLine=[Console]::In.ReadLine())) {
  $memory=$null;$writer=$null
  try {
   $raw=[Convert]::FromBase64String($inputLine.Trim())
   $memory=New-Object IO.MemoryStream;$writer=New-Object IO.BinaryWriter($memory)
   $writer.Write([Text.Encoding]::ASCII.GetBytes('RIFF'));$writer.Write([int](36+$raw.Length))
   $writer.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt '));$writer.Write([int]16)
   $writer.Write([int16]1);$writer.Write([int16]1);$writer.Write([int]16000);$writer.Write([int]32000)
   $writer.Write([int16]2);$writer.Write([int16]16);$writer.Write([Text.Encoding]::ASCII.GetBytes('data'))
   $writer.Write([int]$raw.Length);$writer.Write($raw);$memory.Position=0
   $engine.SetInputToWaveStream($memory)
   $result=$engine.Recognize([TimeSpan]::FromSeconds(12))
   $text=if($null -ne $result -and $result.Confidence -ge 0.2){$result.Text}else{''}
   [Console]::WriteLine((@{text=$text}|ConvertTo-Json -Compress))
  } catch { [Console]::WriteLine('{"error":"recognition_failed"}') }
  finally { $engine.SetInputToNull();if($writer){$writer.Dispose()};if($memory){$memory.Dispose()} }
 }
}finally{$engine.Dispose()}
