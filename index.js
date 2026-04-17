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

// [근본 해결 1] JSON 수신 용량을 50MB로 확장 (데이터 유실 방지)
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

    // [근본 해결 2] 데이터 도착 여부 검증
    if (!tracks || !Array.isArray(tracks)) {
      console.error("❌ 서버가 유효한 트랙 데이터를 받지 못했습니다.");
      return res
        .status(400)
        .json({ error: "Tracks data is missing or invalid." });
    }

    const socket = io.sockets.sockets.get(socketId);
    const tempDir = path.join(__dirname, "temp", projectId);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const outputPath = path.join(tempDir, "output.mp4");

    const { width = 1080, height = 1920, duration = 10 } = settings;

    let command = ffmpeg();

    // [순서 교정] 입력(input)을 먼저 선언
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

          let filter = `[${currentInput}:v]scale=${Math.round(clip.width)}:${Math.round(clip.height)}`;
          if (clip.opacity < 100) {
            filter += `,format=yuva420p,colorchannelmixer=aa=${clip.opacity / 100}`;
          }
          filter += `[scaled${currentInput}];`;
          filter += `[${lastOutputLabel}][scaled${currentInput}]overlay=x=${Math.round(clip.x - clip.width / 2)}:y=${Math.round(clip.y - clip.height / 2)}:enable='between(t,${clip.start},${clip.start + clip.duration})'[${outputLabel}]`;

          filterComplex.push(filter);
          lastOutputLabel = outputLabel;
        } else if (clip.type === "text") {
          const outputLabel = `txt${videoInputIndex++}`;
          const textFilter = `drawtext=text='${clip.text}':fontcolor=${clip.textColor}:fontsize=${clip.fontSize}:x=${Math.round(clip.x - clip.width / 2)}:y=${Math.round(clip.y - clip.height / 2)}:enable='between(t,${clip.start},${clip.start + clip.duration})'`;

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
