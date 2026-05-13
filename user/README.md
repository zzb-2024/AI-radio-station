# User Context

这个目录放本地用户画像和个人偏好文件。真实内容通常不提交到 GitHub。

- `profile.json`：结构化用户画像。`taste/scenes/djStyle/notes` 是可手动编辑层，`auto` 是系统根据播放和聊天自动更新的证据层。
- `taste.md`：音乐口味补充。
- `routines.md`：作息和场景习惯。
- `mood-rules.md`：不同情绪下的选曲规则。
- `playlists.json`：本地歌单偏好。

可以复制 `profile.example.json` 为 `profile.json`，也可以直接在前端 SETTINGS 里保存生成。一般不用手动改 `auto`，它会由后端维护。

自动画像算法说明见项目根目录的 `用户画像算法设计.md`。
