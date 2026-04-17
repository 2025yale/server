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
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

app.post("/render", async (req, res) => {
  try {
    const { projectId, tracks, settings, socketId } = req.body;
    const socket = io.sockets.sockets.get(socketId);

    const tempDir = path.join(__dirname, "temp", projectId);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const outputPath = path.join(tempDir, "output.mp4");

    const { width = 1080, height = 1920, duration = 10 } = settings;

    // 1. FFmpeg 인스턴스 생성 및 '첫 번째 입력' 설정
    // No input specified 에러를 방지하기 위해 input을 먼저 선언합니다.
    let command = ffmpeg();

    // 배경 설정을 첫 번째 입력(0번)으로 지정
    command
      .input(`color=c=black:s=${width}x${height}:d=${duration}`)
      .inputOptions("-f lavfi");

    // 2. 입력이 존재하므로 이제 전역 입력 옵션을 설정할 수 있습니다.
    command.inputOptions([
      "-protocol_whitelist",
      "file,http,https,tcp,tls,crypto",
    ]);

    const filterComplex = [];
    let videoInputIndex = 1;
    let lastOutputLabel = "0:v";

    tracks.forEach((track) => {
      if (!track.visible) return;
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

            if (fs.existsSync(tempDir)) {
              fs.rmSync(tempDir, { recursive: true, force: true });
            }

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
