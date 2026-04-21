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

    const width = settings.width || 405;
    const height = settings.height || 720;
    const fps = settings.fps || 24;
    const scaleRatio = width / 1080;

    let command = ffmpeg();

    command
      .input(`color=c=black:s=${width}x${height}:d=${finalDuration}`)
      .inputOptions("-f lavfi");

    command.inputOptions([
      "-protocol_whitelist",
      "file,http,https,tcp,tls,crypto",
    ]);

    const videoFilters = [];
    const audioFilters = []; // 오디오 필터 처리를 위한 배열 추가
    const audioLabels = []; // 믹싱할 오디오 레이블들
    let currentInputIndex = 1;
    let lastVideoLabel = "0:v";

    const sortedTracks = [...tracks].sort((a, b) => {
      const aId = parseInt(String(a.id).replace(/[^0-9]/g, "")) || 0;
      const bId = parseInt(String(b.id).replace(/[^0-9]/g, "")) || 0;
      return aId - bId;
    });

    sortedTracks.forEach((track) => {
      if (!track || !track.visible || !track.clips) return;

      track.clips.forEach((clip) => {
        const inputIdx = currentInputIndex++;
        command.input(clip.url);

        if (clip.type === "video" || clip.type === "image") {
          const scaledLabel = `v${inputIdx}scaled`;
          const outputLabel = `v${inputIdx}out`;

          const w = Math.round(clip.width * scaleRatio);
          const h = Math.round(clip.height * scaleRatio);
          const x = Math.round((clip.x - clip.width / 2) * scaleRatio);
          const y = Math.round((clip.y - clip.height / 2) * scaleRatio);

          let filter =
            clip.type === "image"
              ? `[${inputIdx}:v]loop=-1:size=1:start=0,trim=duration=${clip.duration},setpts=PTS-STARTPTS+${clip.start}/TB,scale=${w}:${h},format=yuva420p`
              : `[${inputIdx}:v]trim=start=0:duration=${clip.duration},setpts=PTS-STARTPTS+${clip.start}/TB,scale=${w}:${h},format=yuva420p`;

          if (clip.opacity < 100) {
            filter += `,colorchannelmixer=aa=${clip.opacity / 100}`;
          }
          videoFilters.push(`${filter}[${scaledLabel}]`);
          videoFilters.push(
            `[${lastVideoLabel}][${scaledLabel}]overlay=x=${x}:y=${y}:eof_action=pass[${outputLabel}]`,
          );

          lastVideoLabel = outputLabel;

          // 비디오에 포함된 오디오 처리
          if (clip.type === "video") {
            const aLabel = `a${inputIdx}out`;
            // 오디오도 비디오와 동일하게 trim 및 start 지점(delay) 설정
            audioFilters.push(
              `[${inputIdx}:a]atrim=0:${clip.duration},asetpts=PTS-STARTPTS+${clip.start}/TB[${aLabel}]`,
            );
            audioLabels.push(`[${aLabel}]`);
          }
        } else if (clip.type === "audio") {
          const aLabel = `a${inputIdx}out`;
          // 오디오 클립 trim 및 start 지점 설정
          audioFilters.push(
            `[${inputIdx}:a]atrim=0:${clip.duration},asetpts=PTS-STARTPTS+${clip.start}/TB[${aLabel}]`,
          );
          audioLabels.push(`[${aLabel}]`);
        }
      });
    });

    // 모든 비디오 필터와 오디오 필터를 합침
    let finalFilterComplex = videoFilters.join(";");

    if (audioLabels.length > 0) {
      const amixFilter = `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest[aout]`;
      finalFilterComplex +=
        (finalFilterComplex ? ";" : "") +
        audioFilters.join(";") +
        ";" +
        amixFilter;
    }

    console.log("=== FILTER COMPLEX ===");
    console.log(finalFilterComplex);
    console.log("======================");

    await new Promise((resolve, reject) => {
      let finalCommand = command.complexFilter(finalFilterComplex, [
        lastVideoLabel,
      ]);

      if (audioLabels.length > 0) {
        finalCommand = finalCommand.map("aout");
      }

      finalCommand
        .on("progress", (progress) => {
          if (socket) {
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
          fps.toString(),
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
