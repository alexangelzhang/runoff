# runoff race demo — ~30 second GIF
#
# Prerequisites:
#   brew install vhs
#
# Record:
#   cd /path/to/runoff
#   VHS_PORT=7681 vhs demo.tape
#
# Output: docs/assets/demo.gif

Output docs/assets/demo.gif

Set FontSize 13
Set Width 900
Set Height 540
Set Theme "Dracula"
Set Padding 24
Set Shell "bash"
Set PlaybackSpeed 1.0
Set CursorBlink false

# clear the slate
Type "clear"
Enter
Sleep 300ms

# establish context
Type "# Give the same task to two AI models. Pick the winner."
Sleep 2s
Enter
Sleep 500ms

# show the race config
Type "cat examples/configs/race-demo.config.json | grep -A3 'implement'"
Enter
Sleep 1500ms

# clear and run
Type "clear"
Enter
Sleep 300ms

# simulate the race output (mock run — real output captured here)
Type "cat scripts/shell/demo-race-output.txt"
Enter
Sleep 500ms

# pause for viewer to read the two candidates
Sleep 4500ms

# pick the winner
Type "npx runoff race apply --session demo --winner 1"
Enter
Sleep 2000ms

# show result
Type "echo '✓ candidate 1 merged.  worktree 0 cleaned up.'"
Enter
Sleep 2500ms
