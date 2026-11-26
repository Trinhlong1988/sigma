' Launch Zalo keep-alive AN (khong cua so -> khong nhay man hinh Administrator moi 2 phut). WindowStyle 0 = hidden.
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""<REPO>\infra\zalo-watcher-service\keep-zalo-alive.ps1""", 0, True