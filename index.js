const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

app.post("/render", async (req, res) => {
  try {
    const { projectId, tracks, settings, socketId } = req.body;

    if (!tracks || !Array.isArray(tracks)) {
      return res.status(400).json({ error: "Tracks data is missing" });
    }

    const socket = io.sockets.sockets.get(socketId);
    const tempDir = path.join(__dirname, "temp", projectId);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const outputPath = path.join(tempDir, "output.mp4");

    // [수정] 메모리 부족 해결을 위해 해상도를 임시로 낮춤 (540x960)
    const width = 540;
    const height = 960;
    const duration = settings.duration || 10;

    // 원본 대비 스케일 비율 (필터 좌표 계산용)
    const scaleRatio = width / (settings.width || 1080);

    let command = ffmpeg();

    // 배경 생성 및 초기 설정
    command
      .input(`color=c=black:s=${width}x${height}:d=${duration}`)
      .inputOptions("-f lavfi");

    command.inputOptions([
      "-protocol_whitelist",
      "file,http,https,tcp,tls,crypto",
    ]);

    const filterComplex = [];
    let videoInputIndex = 1;
    let lastOutputLabel = "0:v";

    tracks.forEach((track) => {
      if (!track || !track.visible || !track.clips) return;
      track.clips.forEach((clip) => {
        if (clip.type === "video" || clip.type === "image") {
          command.input(clip.url);
          const currentInput = videoInputIndex++;
          const outputLabel = `v${currentInput}`;

          // [수정] 좌표 및 크기를 변경된 해상도 비율에 맞게 조정
          const w = Math.round(clip.width * scaleRatio);
          const h = Math.round(clip.height * scaleRatio);
          const x = Math.round((clip.x - clip.width / 2) * scaleRatio);
          const y = Math.round((clip.y - clip.height / 2) * scaleRatio);

          let filter = `[${currentInput}:v]scale=${w}:${h}`;
          if (clip.opacity < 100) {
            filter += `,format=yuva420p,colorchannelmixer=aa=${clip.opacity / 100}`;
          }
          filter += `[scaled${currentInput}];`;
          filter += `[${lastOutputLabel}][scaled${currentInput}]overlay=x=${x}:y=${y}:enable='between(t,${clip.start},${clip.start + clip.duration})'[${outputLabel}]`;

          filterComplex.push(filter);
          lastOutputLabel = outputLabel;
        } else if (clip.type === "text") {
          const outputLabel = `txt${videoInputIndex++}`;
          const fontSize = Math.round(clip.fontSize * scaleRatio);
          const x = Math.round((clip.x - clip.width / 2) * scaleRatio);
          const y = Math.round((clip.y - clip.height / 2) * scaleRatio);

          const textFilter = `drawtext=text='${clip.text}':fontcolor=${clip.textColor}:fontsize=${fontSize}:x=${x}:y=${y}:enable='between(t,${clip.start},${clip.start + clip.duration})'`;

          filterComplex.push(
            `[${lastOutputLabel}]${textFilter}[${outputLabel}]`,
          );
          lastOutputLabel = outputLabel;
        } else if (clip.type === "audio") {
          command.input(clip.url);
        }
      });
    });

    const finalFilter =
      filterComplex.length > 0 ? filterComplex.join(";") : "copy";

    await new Promise((resolve, reject) => {
      command
        .complexFilter(finalFilter, lastOutputLabel)
        .on("progress", (progress) => {
          if (socket)
            socket.emit("render-progress", { percent: progress.percent || 0 });
        })
        .on("error", (err) => {
          console.error("FFmpeg Error:", err);
          reject(err);
        })
        .on("end", async () => {
          try {
            if (
              !fs.existsSync(outputPath) ||
              fs.statSync(outputPath).size === 0
            ) {
              throw new Error("Rendered file is empty.");
            }
            const fileContent = fs.readFileSync(outputPath);
            const fileName = `render_${projectId}_${Date.now()}.mp4`;
            const { error: uploadError } = await supabase.storage
              .from("exports")
              .upload(fileName, fileContent, {
                contentType: "video/mp4",
                upsert: true,
              });
            if (uploadError) throw uploadError;
            const {
              data: { publicUrl },
            } = supabase.storage.from("exports").getPublicUrl(fileName);
            if (fs.existsSync(tempDir))
              fs.rmSync(tempDir, { recursive: true, force: true });
            if (socket) socket.emit("render-complete", { url: publicUrl });
            resolve();
          } catch (err) {
            reject(err);
          }
        })
        .outputOptions([
          "-t",
          duration.toString(),
          "-pix_fmt",
          "yuv420p",
          "-preset",
          "ultrafast", // [수정] CPU/메모리 부하 최소화
          "-max_muxing_queue_size",
          "1024", // [수정] 메모리 대기열 제한
          "-movflags",
          "faststart",
        ])
        .save(outputPath);
    });

    if (!res.headersSent) res.json({ success: true });
  } catch (error) {
    console.error("Render error:", error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
