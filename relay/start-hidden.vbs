' Hidden launcher for the Your Browser Agent relay (Windows).
' Runs node relay.js from this script's own folder, with no console window.
' Requires Node.js to be on your PATH.
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = baseDir
sh.Run "node relay.js", 0, False
