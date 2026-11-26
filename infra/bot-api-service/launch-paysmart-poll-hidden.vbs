' Chay paysmart-poll AN (khong cua so console nhay moi 30 phut). WindowStyle 0 = hidden.
' Task: SigMa_PaysmartPoll - truoc day goi node.exe truc tiep -> bung cua so.
'
' [14/10 - R198 CAM NUOT LOI] Ban cu: sh.Run(...) roi BO exit code, khong ghi log gi ca -> Task Scheduler
' LUON rc=0 ke ca khi poll chet (login fail / chromium thieu / DB sap). Ma 187 im 23 ngay ma khong co cach nao
' biet la hong that hay don gian khong co giao dich. Nay: stdout+stderr ghi vao _paysmart-poll.log, exit code cua
' node TRA VE Task Scheduler (WScript.Quit rc) -> cot LastTaskResult noi dung su that.
Option Explicit
Dim sh, fso, q, logFile, cmdLine, rc, f
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)
logFile = "<REPO>\infra\bot-api-service\_paysmart-poll.log"

' Cat log khi qua 2MB (giu 1 ban .1) - chay 48 lan/ngay nen khong de no phinh vo han.
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 2097152 Then
    If fso.FileExists(logFile & ".1") Then fso.DeleteFile logFile & ".1", True
    fso.MoveFile logFile, logFile & ".1"
  End If
End If

Set f = fso.OpenTextFile(logFile, 8, True)
f.WriteLine Now & " [paysmart-poll] BAT DAU luot poll"
f.Close

sh.CurrentDirectory = "<REPO>\apps\bot-api"
cmdLine = "cmd /c " & q & q & "C:\Program Files\nodejs\node.exe" & q & " " & _
  q & "<REPO>\node_modules\tsx\dist\cli.mjs" & q & _
  " scripts\paysmart-poll.mts >> " & q & logFile & q & " 2>&1" & q
rc = sh.Run(cmdLine, 0, True)

Set f = fso.OpenTextFile(logFile, 8, True)
f.WriteLine Now & " [paysmart-poll] KET THUC exit=" & rc
f.Close

' Tra exit code that -> task rc != 0 khi co ma loi (script exit 1 neu BAT KY ma nao khong keo duoc).
WScript.Quit rc
