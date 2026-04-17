const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const cors = require("cors"); // CORS 문제 해결을 위해 추가
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);

// CORS 설정: 클라이언트의 접근을 허용합니다.
app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: "*", // 모든 오리진 허용
    methods: ["GET", "POST"],
  },
});

// 지적하신 환경 변수 방식을 유지합니다.
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

    let command = ffmpeg();

    // 배경 설정 (검은색 배경)
    command
      .input(`color=c=black:s=${width}x${height}:d=${duration}`)
      .inputOptions("-f lavfi");

    const filterComplex = [];
    let inputCount = 1;

    tracks.forEach((track) => {
      if (!track.visible) return;
      track.clips.forEach((clip) => {
        if (clip.type === "video" || clip.type === "image") {
          command.input(clip.url);
          const idx = inputCount++;

          let filter = `[${idx}:v]scale=${clip.width}:${clip.height}`;
          if (clip.opacity < 100) {
            filter += `,format=yuva420p,colorchannelmixer=aa=${clip.opacity / 100}`;
          }
          filter += `[v${idx}];`;
          filter += `[${idx === 1 ? "0" : "tmp"}]v${idx}]overlay=x=${clip.x - clip.width / 2}:y=${clip.y - clip.height / 2}:enable='between(t,${clip.start},${clip.start + clip.duration})'[tmp]`;
          filterComplex.push(filter);
        } else if (clip.type === "text") {
          const textFilter = `drawtext=text='${clip.text}':fontcolor=${clip.textColor}:fontsize=${clip.fontSize}:x=${clip.x - clip.width / 2}:y=${clip.y - clip.height / 2}:enable='between(t,${clip.start},${clip.start + clip.duration})'`;
          filterComplex.push(
            `[${filterComplex.length === 0 ? "0" : "tmp"}]${textFilter}[tmp]`,
          );
        } else if (clip.type === "audio") {
          command.input(clip.url);
          inputCount++;
        }
      });
    });

    const finalFilter =
      filterComplex.length > 0 ? filterComplex.join(";") : "copy";

    await new Promise((resolve, reject) => {
      command
        .complexFilter(
          finalFilter,
          filterComplex.length > 0 ? "tmp" : undefined,
        )
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

            fs.rmSync(tempDir, { recursive: true, force: true });
            if (socket) socket.emit("render-complete", { url: publicUrl });

            resolve();
          } catch (err) {
            reject(err);
          }
        })
        .outputOptions("-t", duration.toString())
        .save(outputPath);
    });

    // 모든 비동기 작업이 끝난 뒤 응답을 보냅니다.
    res.json({ success: true });
  } catch (error) {
    console.error("Render error:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
