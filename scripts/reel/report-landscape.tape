# trce report reel, landscape for the X feed (16:10). Render: vhs011 report-landscape.tape
# Records whatever `trce` is on PATH. Swap the typed command for `npx @trce/cli report` at release.
Output report-landscape.mp4
Output report-landscape.gif

Set Shell zsh
Set FontFamily "JetBrains Mono"
Set FontSize 18
Set LineHeight 1.25
Set Width 1600
Set Height 1000
Set Padding 36
Set Theme { "background": "#0f0f14", "foreground": "#e6e4ee", "cursor": "#e6e4ee", "selection": "#2a2933" }
Set TypingSpeed 55ms

Hide
Type "clear"
Enter
Show

Sleep 900ms
Type "trce report"
Sleep 600ms
Enter
# the scan on this laptop takes about nine seconds, then the reveal about two
Sleep 16s
# hold the final screen
Sleep 4s
