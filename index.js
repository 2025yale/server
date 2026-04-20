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

// 시간 문자열(HH:MM:SS.MS)을 초 단위 숫자로 변환하는 헬퍼 함수
const timeToSeconds = (timeStr) => {
  if (!timeStr) return 0;
  const parts = timeStr.split(":");
  let seconds = 0;
  if (parts.length === 3) {
    seconds += parseInt(parts[0]) * 3600;
    seconds += parseInt(parts[1]) * 60;
    seconds += parseFloat(parts[2]);
  }
  return seconds;
};

app.post("/render", async (req, res) => {
  try {
    const { projectId, tracks, settings, socketId } = req.body;

    if (!tracks || !Array.isArray(tracks)) {
      return res.status(400).json({ error: "Tracks data is missing" });
    }

    const socket = io.sockets.sockets.get(socketId);
    const tempDir = path.join(__dirname, "temp", projectId);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    // 선택한 확장자 적용
    const extension = settings.ext || "mp4";
    const outputPath = path.join(tempDir, `output.${extension}`);

    let maxDuration = 0;
    tracks.forEach((track) => {
      track.clips.forEach((clip) => {
        maxDuration = Math.max(maxDuration, clip.start + clip.duration);
      });
    });
    const finalDuration =
      maxDuration > 0 ? maxDuration : settings.totalDuration || 5;

    // 전달받은 해상도 및 FPS 설정
    const width = settings.width || 405;
    const height = settings.height || 720;
    const fps = settings.fps || 24;
    const scaleRatio = width / 1080; // 원본 기준 좌표 계산용

    let command = ffmpeg();

    command
      .input(`color=c=black:s=${width}x${height}:d=${finalDuration}`)
      .inputOptions("-f lavfi");

    command.inputOptions([
      "-protocol_whitelist",
      "file,http,https,tcp,tls,crypto",
    ]);

    const videoFilters = [];
    const audioInputs = [];
    let currentInputIndex = 1;
    let lastVideoLabel = "0:v";

    const sortedTracks = [...tracks].sort((a, b) => {
      const aId = parseInt(String(a.id).replace(/[^0-9]/g, "")) || 0;
      const bId = parseInt(String(b.id).replace(/[^0-9]/g, "")) || 0;
      return bId - aId;
    });

    sortedTracks.forEach((track) => {
      if (!track || !track.visible || !track.clips) return;

      track.clips.forEach((clip) => {
        if (clip.type === "video" || clip.type === "image") {
          command.input(clip.url);
          const inputIdx = currentInputIndex++;
          const scaledLabel = `v${inputIdx}scaled`;
          const outputLabel = `v${inputIdx}out`;

          const w = Math.round(clip.width * scaleRatio);
          const h = Math.round(clip.height * scaleRatio);
          const x = Math.round((clip.x - clip.width / 2) * scaleRatio);
          const y = Math.round((clip.y - clip.height / 2) * scaleRatio);

          let filter = `[${inputIdx}:v]scale=${w}:${h},format=yuva420p`;
          if (clip.opacity < 100) {
            filter += `,colorchannelmixer=aa=${clip.opacity / 100}`;
          }
          videoFilters.push(`${filter}[${scaledLabel}]`);
          // format=auto 옵션을 추가하여 알파 채널 합성을 명확히 함
          videoFilters.push(
            `[${lastVideoLabel}][${scaledLabel}]overlay=x=${x}:y=${y}:format=auto:enable='between(t,${clip.start},${clip.start + clip.duration})'[${outputLabel}]`,
          );

          lastVideoLabel = outputLabel;

          if (clip.type === "video") {
            audioInputs.push(`[${inputIdx}:a]`);
          }
        } else if (clip.type === "audio") {
          command.input(clip.url);
          const inputIdx = currentInputIndex++;
          audioInputs.push(`[${inputIdx}:a]`);
        }
      });
    });

    if (audioInputs.length > 0) {
      const amixFilter = `${audioInputs.join("")}amix=inputs=${audioInputs.length}:duration=longest[aout]`;
      videoFilters.push(amixFilter);
    }

    const finalFilterComplex = videoFilters.join(";");

    await new Promise((resolve, reject) => {
      let finalCommand = command.complexFilter(finalFilterComplex, [
        lastVideoLabel,
      ]);

      if (audioInputs.length > 0) {
        finalCommand = finalCommand.map("aout");
      }

      finalCommand
        .on("progress", (progress) => {
          if (socket) {
            // 시간 기반 진행률 계산 (timemark: HH:MM:SS.MS)
            const currentTime = timeToSeconds(progress.timemark);
            const percent = (currentTime / finalDuration) * 100;
            socket.emit("render-progress", { percent: Math.min(99, percent) });
          }
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
            )
              throw new Error("Output file is empty");

            const fileContent = fs.readFileSync(outputPath);
            const fileName = `render_${projectId}_${Date.now()}.${extension}`;
            const { error: uploadError } = await supabase.storage
              .from("exports")
              .upload(fileName, fileContent, {
                contentType:
                  extension === "mp4" ? "video/mp4" : "video/quicktime",
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
          finalDuration.toString(),
          "-r",
          fps.toString(), // FPS 설정 주입
          "-pix_fmt",
          "yuv420p",
          "-preset",
          "ultrafast",
          "-max_muxing_queue_size",
          "1024",
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
