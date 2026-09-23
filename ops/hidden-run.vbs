' 隐藏运行任意命令（不弹窗）—— 用于计划任务/开机启动拉起后台脚本
' 用法：wscript.exe hidden-run.vbs "<exe 路径>" "<参数1>" "<参数2>" ...
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  If i > 0 Then cmd = cmd & " "
  cmd = cmd & """" & WScript.Arguments(i) & """"
Next
If cmd = "" Then WScript.Quit 1
' 0 = 隐藏窗口，False = 不等待
sh.Run cmd, 0, False
