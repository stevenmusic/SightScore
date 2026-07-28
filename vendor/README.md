# vendor

這裡放的是**靜態部署（GitHub Pages）需要的第三方檔案**，直接進版控，讓網站不需要 build step 或 `npm install` 就能跑。

- `opensheetmusicdisplay.min.js` — OpenSheetMusicDisplay v2.1.0，取自 `node_modules/opensheetmusicdisplay/build/`

更新方式：

```bash
npm install opensheetmusicdisplay@<版本>
cp node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js vendor/
```

記得同步更新上面的版本號。
