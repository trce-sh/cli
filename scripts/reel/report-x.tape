# trce report reel for X: 4:5 portrait at 1080x1350, H.264 MP4. Shows the whole report on a
# phone at full height, with larger text relative to width than a 16:9 frame.
# Render: vhs011 report-x.tape   Post the MP4.
# Records whatever `trce` is on PATH. Swap the typed command for `npx @trce/cli report` at release.
Output report-x.mp4

Set Shell zsh
Set FontFamily "JetBrains Mono"
Set FontSize 15
Set LineHeight 1.25
Set Width 1080
Set Height 1350
Set Padding 36
Set Framerate 30
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
# scan on this laptop is about nine seconds, then the reveal about two
Sleep 16s
# hold the final screen
Sleep 5s
