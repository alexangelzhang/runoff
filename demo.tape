# runoff race demo — ~30 second GIF
#
# Record:
#   cd /path/to/runoff
#   VHS_PORT=7681 vhs demo.tape
#
# Output: docs/assets/demo.gif

Output docs/assets/demo.gif

Set FontSize 13
Set Width 900
Set Height 580
Set Theme "Dracula"
Set Padding 24
Set Shell "bash"
Set PlaybackSpeed 1.0
Set CursorBlink false

Type "cd /Users/zhangyiqian/private-dev/runoff && clear"
Enter
Sleep 400ms

Type "# Same prompt. Two models. You pick the winner."
Sleep 1800ms
Enter
Sleep 500ms

# 运行 race，把输出存到文件以便后面提取 session ID
Type "npm run demo:race 2>/dev/null | tee /tmp/race-out.txt"
Enter
Sleep 500ms

# 等 awaiting_judge 出现
Sleep 5500ms

# 让观众看清候选
Sleep 3000ms

# 从输出里提取 session ID，然后 apply winner 1
Type "SID=$(grep 'session:' /tmp/race-out.txt | awk '{print $2}') && npm run pipeline:race:apply -- --session $SID --winner 1"
Enter
Sleep 3000ms
