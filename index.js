const express = require("express");
const { exec } = require("child_process");
const app = express();
const port = process.env.PORT || 3000;

app.get("/check-ffmpeg", (req, res) => {
  exec("ffmpeg -version", (error, stdout, stderr) => {
    if (error) {
      return res.status(500).send(`FFmpeg 없음: ${error.message}`);
    }
    res.send(`FFmpeg 설치됨: ${stdout.split("\n")[0]}`);
  });
});

app.listen(port, () => {
  console.log(`Renderer server listening at http://localhost:${port}`);
});
