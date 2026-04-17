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

    // 실제 영상 길이 계산 (가장 마지막 클립 기준)
    let maxDuration = 0;
    tracks.forEach((track) => {
      track.clips.forEach((clip) => {
        maxDuration = Math.max(maxDuration, clip.start + clip.duration);
      });
    });
    const finalDuration = maxDuration > 0 ? maxDuration : 5;

    const width = 540;
    const height = 960;
    const scaleRatio = width / (settings.width || 1080);

    let command = ffmpeg();

    // 0번 입력: 배경 (모든 오버레이의 베이스)
    command
      .input(`color=c=black:s=${width}x${height}:d=${finalDuration}`)
      .inputOptions("-f lavfi");

    command.inputOptions([
      "-protocol_whitelist",
      "file,http,https,tcp,tls,crypto",
    ]);

    const videoFilters = [];
    const audioInputs = [];
    let currentInputIndex = 1; // 0번은 배경
    let lastVideoLabel = "0:v";

    // [규칙] 1번 트랙이 최상단에 오려면, 배열의 뒷번호 트랙부터 배경 위에 쌓아야 함
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

          // 비디오 스케일링 및 오버레이 필터 체인
          let filter = `[${inputIdx}:v]scale=${w}:${h},format=yuva420p`;
          if (clip.opacity < 100) {
            filter += `,colorchannelmixer=aa=${clip.opacity / 100}`;
          }
          videoFilters.push(`${filter}[${scaledLabel}]`);
          videoFilters.push(
            `[${lastVideoLabel}][${scaledLabel}]overlay=x=${x}:y=${y}:enable='between(t,${clip.start},${clip.start + clip.duration})'[${outputLabel}]`,
          );

          lastVideoLabel = outputLabel;

          // 오디오 추출 (비디오 타입인 경우에만)
          if (clip.type === "video") {
            audioInputs.push(`[${inputIdx}:a]`);
          }
        } else if (clip.type === "audio") {
          command.input(clip.url);
          const inputIdx = currentInputIndex++;
          audioInputs.push(`[${inputIdx}:a]`);
        }
        // text 타입은 현재 비활성화 (필요 시 로직 추가)
      });
    });

    // 오디오 믹싱 필터
    if (audioInputs.length > 0) {
      const amixFilter = `${audioInputs.join("")}amix=inputs=${audioInputs.length}:duration=longest[aout]`;
      videoFilters.push(amixFilter);
    }

    const finalFilterComplex = videoFilters.join(";");

    await new Promise((resolve, reject) => {
      // complexFilter의 두 번째 인자로 lastVideoLabel을 주면 이것이 최종 [v]가 됨
      let finalCommand = command.complexFilter(finalFilterComplex, [
        lastVideoLabel,
      ]);

      // 오디오가 있는 경우에만 오디오 출력 매핑 추가
      if (audioInputs.length > 0) {
        finalCommand = finalCommand.map("aout");
      }

      finalCommand
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
            )
              throw new Error("Output file is empty");
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
          finalDuration.toString(),
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
