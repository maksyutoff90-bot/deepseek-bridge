' Тихо запускает шлюз WebCode при входе в Windows.
' Ярлык на этот файл кладёт в автозагрузку install-autostart.ps1.
Option Explicit
Dim fso, sh, dir, server, nodeExe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
server = dir & "\gateway\server.mjs"
If Not fso.FileExists(server) Then WScript.Quit 1
nodeExe = "node"
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
  nodeExe = """C:\Program Files\nodejs\node.exe"""
End If
sh.CurrentDirectory = dir
sh.Run nodeExe & " """ & server & """", 0, False
