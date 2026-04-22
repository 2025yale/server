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

const FONT_PATHS = {
  NotoSansKR: {
    normal: path.join(__dirname, "assets", "fonts", "NotoSansKR-Medium.ttf"),
    bold: path.join(__dirname, "assets", "fonts", "NotoSansKR-Bold.ttf"),
  },
  NanumSquare: {
    normal: path.join(__dirname, "assets", "fonts", "NanumSquareR.ttf"),
    bold: path.join(__dirname, "assets", "fonts", "NanumSquareB.ttf"),
  },
  BlackHanSans: {
    normal: path.join(__dirname, "assets", "fonts", "BlackHanSans-Regular.ttf"),
  },
  BMJUA: {
    normal: path.join(__dirname, "assets", "fonts", "BMJUA.ttf"),
  },
  MaruMinya: {
    normal: path.join(__dirname, "assets", "fonts", "MaruMinya.ttf"),
  },
  NanumBrush: {
    normal: path.join(__dirname, "assets", "fonts", "NanumBrush.ttf"),
  },
  NanumPen: {
    normal: path.join(__dirname, "assets", "fonts", "NanumPen.ttf"),
  },
  "NanumMyeongjo-YetHangul": {
    normal: path.join(
      __dirname,
      "assets",
      "fonts",
      "NanumMyeongjo-YetHangul.ttf",
    ),
  },
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

    // [근본적 해결] ID 숫자가 아닌, 배열의 인덱스 순서를 기준으로 레이어를 잡습니다.
    // 트랙 배열의 끝(아래쪽 트랙)부터 시작하여 0번째(맨 위 트랙)까지 역순으로 렌더링합니다.
    const reversedTracks = [...tracks].reverse();

    reversedTracks.forEach((track) => {
      if (!track || !track.visible || !track.clips) return;

      const sortedClips = [...track.clips].sort((a, b) => a.start - b.start);

      sortedClips.forEach((clip) => {
        filterCounter++;

        if (clip.type === "video" || clip.type === "image") {
          const inputIdx = currentInputIndex++;
          command.input(clip.url);

          const scaledLabel = `v${filterCounter}scaled`;
          const outputLabel = `v${filterCounter}out`;

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
        } else if (clip.type === "text") {
          const outputLabel = `t${filterCounter}out`;

          const textContent = (clip.text || clip.title || "")
            .replace(/\\/g, "\\\\\\\\")
            .replace(/'/g, "'\\\\\\''")
            .replace(/:/g, "\\\\:");

          const fontSize = Math.round((clip.fontSize || 40) * 2 * scaleRatio);
          const fontColor = (clip.textColor || "#ffffff").replace("#", "0x");
          const opacity = (clip.opacity ?? 100) / 100;

          const boxW = (clip.width || 800) * scaleRatio;
          const boxH = (clip.height || 200) * scaleRatio;
          const startX = Math.round(clip.x * scaleRatio - boxW / 2);
          const startY = Math.round(clip.y * scaleRatio - boxH / 2);

          const fontFam = clip.fontFamily || "NotoSansKR";
          const isBold = clip.fontWeight === "bold";
          let fontPath =
            FONT_PATHS[fontFam]?.normal || FONT_PATHS["NotoSansKR"].normal;
          if (isBold && FONT_PATHS[fontFam]?.bold) {
            fontPath = FONT_PATHS[fontFam].bold;
          }

          if (!fs.existsSync(fontPath)) {
            fontPath = FONT_PATHS["NotoSansKR"].normal;
          }

          const escapedFontPath = fontPath
            .replace(/\\/g, "/")
            .replace(/:/g, "\\:");

          const drawTextFilter = `drawtext=fontfile='${escapedFontPath}':text='${textContent}':fontcolor=${fontColor}@${opacity}:fontsize=${fontSize}:x=${startX}+((${boxW}-text_w)/2):y=${startY}+((${boxH}-text_h)/2):enable='between(t,${clip.start},${clip.start + clip.duration})'`;

          videoFilters.push(
            `[${lastVideoLabel}]${drawTextFilter}[${outputLabel}]`,
          );
          lastVideoLabel = outputLabel;
        }
      });
    });

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
