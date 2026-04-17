const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(cors());
app.use(express.json());

// Railway 환경변수 세팅 필요
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const parseProgress = (data, totalDuration, socket) => {
  const timeMatch = data.match(/time=(\d{2}):(\d{2}):(\d{2}.\d{2})/);
  if (timeMatch && totalDuration > 0) {
    const hours = parseInt(timeMatch[1]);
    const minutes = parseInt(timeMatch[2]);
    const seconds = parseFloat(timeMatch[3]);
    const currentTime = hours * 3600 + minutes * 60 + seconds;
    const percent = Math.min(99, (currentTime / totalDuration) * 100);
    socket.emit("render-progress", { percent: percent.toFixed(1) });
  }
};

app.post("/render", async (req, res) => {
  const { projectId, tracks, settings, socketId } = req.body;
  const tempDir = path.join(__dirname, "temp", `${projectId}_${Date.now()}`);
  const socket = io.sockets.sockets.get(socketId);

  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  try {
    const allClips = tracks.flatMap((track) => track.clips);

    // 1. 리소스 다운로드 (텍스트 제외)
    const downloadPromises = allClips.map(async (clip, index) => {
      if (!clip.url || clip.type === "text") return;
      const ext =
        path.extname(clip.url).split("?")[0] ||
        (clip.type === "video" ? ".mp4" : ".png");
      const filePath = path.join(tempDir, `input_${index}${ext}`);
      const response = await axios({
        url: clip.url,
        method: "GET",
        responseType: "stream",
      });
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);
      return new Promise((resolve) => {
        writer.on("finish", () => {
          clip.localPath = filePath;
          resolve();
        });
      });
    });

    await Promise.all(downloadPromises);

    // 2. FFmpeg 명령어 조립
    const outputPath = path.join(tempDir, "output.mp4");
    const inputFiles = allClips
      .filter((c) => c.localPath)
      .map((c) => `-i "${c.localPath}"`)
      .join(" ");

    let filterComplex = `color=s=${settings.width}x${settings.height}:c=black:d=${settings.duration}[base];`;
    let lastVideoLabel = "base";
    let audioLabels = [];
    let inputIdx = 0;

    allClips.forEach((clip, i) => {
      if (clip.type === "text") {
        const nextLabel = `txt${i}`;
        // drawtext 필터 사용 (좌상단 x, y 그대로 적용)
        filterComplex += `[${lastVideoLabel}]drawtext=text='${clip.text}':fontcolor=${clip.textColor}:fontsize=${clip.fontSize}:x=${clip.x}:y=${clip.y}:enable='between(t,${clip.start},${clip.start + clip.duration})'[${nextLabel}];`;
        lastVideoLabel = nextLabel;
      } else if (clip.localPath) {
        const currentInput = inputIdx++;

        // 비디오/이미지 오버레이
        if (clip.type !== "audio") {
          const nextLabel = `ov${i}`;
          filterComplex += `[${lastVideoLabel}][${currentInput}:v]overlay=x=${clip.x}:y=${clip.y}:enable='between(t,${clip.start},${clip.start + clip.duration})'[${nextLabel}];`;
          lastVideoLabel = nextLabel;
        }

        // 오디오 믹싱 레이블 추가
        if (clip.type === "video" || clip.type === "audio") {
          const audioLabel = `a${i}`;
          filterComplex += `[${currentInput}:a]adelay=${clip.start * 1000}|${clip.start * 1000}[${audioLabel}];`;
          audioLabels.push(`[${audioLabel}]`);
        }
      }
    });

    // 오디오가 있을 경우 합치기, 없으면 무음 추가
    let audioMap = "";
    if (audioLabels.length > 0) {
      filterComplex += `${audioLabels.join("")}amix=inputs=${audioLabels.length}[out_a]`;
      audioMap = '-map "[out_a]"';
    }

    const ffmpegCmd = `ffmpeg -y ${inputFiles} -filter_complex "${filterComplex}" -map "[${lastVideoLabel}]" ${audioMap} -c:v libx264 -pix_fmt yuv420p "${outputPath}"`;

    const ffmpegProcess = exec(ffmpegCmd);
    ffmpegProcess.stderr.on("data", (data) => {
      if (socket) parseProgress(data.toString(), settings.duration, socket);
    });

    ffmpegProcess.on("close", async () => {
      const fileContent = fs.readFileSync(outputPath);
      const fileName = `render_${projectId}.mp4`;

      // Supabase 'exports' 버킷에 업로드 (없으면 미리 만들어야 함)
      await supabase.storage
        .from("exports")
        .upload(fileName, fileContent, {
          contentType: "video/mp4",
          upsert: true,
        });
      const {
        data: { publicUrl },
      } = supabase.storage.from("exports").getPublicUrl(fileName);

      fs.rmSync(tempDir, { recursive: true, force: true });
      if (socket) socket.emit("render-complete", { url: publicUrl });
    });

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
