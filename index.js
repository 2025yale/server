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
    const audioFilters = [];
    const audioLabels = [];
    let currentInputIndex = 1;
    let lastVideoLabel = "0:v";
    let filterCounter = 0;

    const reversedTracks = [...tracks].reverse();

    for (const track of reversedTracks) {
      if (!track || !track.visible || !track.clips) continue;

      const sortedClips = [...track.clips].sort((a, b) => a.start - b.start);

      for (const clip of sortedClips) {
        filterCounter++;

        // 텍스트를 이미지로 처리 (Client-side Rendering 방식 적용)
        if (
          clip.type === "video" ||
          clip.type === "image" ||
          clip.type === "text"
        ) {
          const inputIdx = currentInputIndex++;
          let inputSource = clip.url;

          // 텍스트 타입인 경우 base64 이미지를 파일로 임시 저장하여 FFmpeg에 입력
          if (clip.type === "text" && clip.textImageUrl) {
            const textImgPath = path.join(tempDir, `text_${clip.id}.png`);
            const base64Data = clip.textImageUrl.replace(
              /^data:image\/png;base64,/,
              "",
            );
            fs.writeFileSync(textImgPath, base64Data, "base64");
            inputSource = textImgPath;
          }

          command.input(inputSource);

          const scaledLabel = `v${filterCounter}scaled`;
          const outputLabel = `v${filterCounter}out`;

          // 텍스트의 경우 realWidth/realHeight 사용
          const rawW =
            clip.type === "text" ? clip.realWidth || clip.width : clip.width;
          const rawH =
            clip.type === "text" ? clip.realHeight || clip.height : clip.height;

          const w = Math.round(rawW * scaleRatio);
          const h = Math.round(rawH * scaleRatio);
          const x = Math.round(clip.x * scaleRatio);
          const y = Math.round(clip.y * scaleRatio);

          let transformArr = [`scale=${w}:${h}`, "format=yuva420p"];

          if (clip.scaleX === -1) transformArr.push("hflip");
          if (clip.scaleY === -1) transformArr.push("vflip");

          let finalX = x - w / 2; // 중심점 보정
          let finalY = y - h / 2;

          if (clip.rotation && clip.rotation !== 0) {
            const rad = (clip.rotation * Math.PI) / 180;
            const diagonal = Math.round(Math.sqrt(w * w + h * h));
            const padX = Math.round((diagonal - w) / 2);
            const padY = Math.round((diagonal - h) / 2);

            transformArr.push(
              `pad=${diagonal}:${diagonal}:${padX}:${padY}:color=black@0`,
            );
            transformArr.push(`rotate=${rad}:c=none`);

            finalX = finalX - padX;
            finalY = finalY - padY;
          }

          const transformStr = transformArr.join(",");

          let filter =
            clip.type === "image" || clip.type === "text"
              ? `[${inputIdx}:v]loop=-1:size=1:start=0,trim=duration=${clip.duration},setpts=PTS-STARTPTS+${clip.start}/TB,${transformStr}`
              : `[${inputIdx}:v]trim=start=0:duration=${clip.duration},setpts=PTS-STARTPTS+${clip.start}/TB,${transformStr}`;

          const opacityValue =
            (clip.type === "text" ? (clip.opacity ?? 100) : clip.opacity) / 100;
          if (opacityValue < 1) {
            filter += `,colorchannelmixer=aa=${opacityValue}`;
          }

          videoFilters.push(`${filter}[${scaledLabel}]`);
          videoFilters.push(
            `[${lastVideoLabel}][${scaledLabel}]overlay=x=${Math.round(finalX)}:y=${Math.round(finalY)}:eof_action=pass:format=auto[${outputLabel}]`,
          );

          lastVideoLabel = outputLabel;

          if (clip.type === "video") {
            const aLabel = `a${inputIdx}out`;
            const delayMs = Math.max(0, Math.round(clip.start * 1000));
            audioFilters.push(
              `[${inputIdx}:a]atrim=0:${clip.duration},adelay=${delayMs}|${delayMs}[${aLabel}]`,
            );
            audioLabels.push(`[${aLabel}]`);
          }
        } else if (clip.type === "audio") {
          const inputIdx = currentInputIndex++;
          command.input(clip.url);
          const aLabel = `a${inputIdx}out`;
          const delayMs = Math.max(0, Math.round(clip.start * 1000));
          audioFilters.push(
            `[${inputIdx}:a]atrim=0:${clip.duration},adelay=${delayMs}|${delayMs}[${aLabel}]`,
          );
          audioLabels.push(`[${aLabel}]`);
        }
      }
    }

    let finalFilterComplex = videoFilters.join(";");

    if (audioLabels.length > 0) {
      const amixFilter = `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest[aout]`;
      finalFilterComplex +=
        (finalFilterComplex ? ";" : "") +
        audioFilters.join(";") +
        ";" +
        amixFilter;
    }

    await new Promise((resolve, reject) => {
      let finalCommand = command.complexFilter(finalFilterComplex, [
        lastVideoLabel,
      ]);
      if (audioLabels.length > 0) finalCommand = finalCommand.map("aout");

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
