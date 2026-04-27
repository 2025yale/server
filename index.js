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

          // Konva 중심점 기준 좌표 계산
          const x = clip.x * scaleRatio;
          const y = clip.y * scaleRatio;

          let transformArr = [`scale=${w}:${h}`, "format=yuva420p"];

          if (clip.scaleX === -1) transformArr.push("hflip");
          if (clip.scaleY === -1) transformArr.push("vflip");

          let finalX = x - w / 2;
          let finalY = y - h / 2;

          if (clip.rotation && clip.rotation !== 0) {
            const rad = (clip.rotation * Math.PI) / 180;
            // 회전 시 캔버스가 잘리지 않도록 ow/oh 설정
            transformArr.push(`rotate=${rad}:c=none:ow='hypot(iw,ih)':oh='ow'`);
            const diagonal = Math.sqrt(w * w + h * h);
            finalX = x - diagonal / 2;
            finalY = y - diagonal / 2;
          }

          const transformStr = transformArr.join(",");

          let filter =
            clip.type === "image"
              ? `[${inputIdx}:v]loop=-1:size=1:start=0,trim=duration=${clip.duration},setpts=PTS-STARTPTS+${clip.start}/TB,${transformStr}`
              : `[${inputIdx}:v]trim=start=0:duration=${clip.duration},setpts=PTS-STARTPTS+${clip.start}/TB,${transformStr}`;

          if (clip.opacity < 100) {
            filter += `,colorchannelmixer=aa=${clip.opacity / 100}`;
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
        } else if (clip.type === "text") {
          const textCanvasLabel = `t${filterCounter}canvas`;
          const textRotateLabel = `t${filterCounter}rot`;
          const outputLabel = `t${filterCounter}out`;

          const rawText = clip.wrappedText || clip.text || clip.title || "";

          const textContent = rawText
            .replace(/\\/g, "\\\\\\\\")
            .replace(/'/g, "'\\\\\\''")
            .replace(/:/g, "\\\\:");

          const fontSize = Math.round((clip.fontSize || 40) * 2 * scaleRatio);
          const fontColor = (clip.textColor || "#ffffff").replace("#", "0x");
          const opacity = (clip.opacity ?? 100) / 100;

          // 클라이언트에서 넘겨준 renderedHeight를 우선 사용 (잘림 방지 핵심)
          const boxW = (clip.width || 800) * scaleRatio;
          const boxH = (clip.renderedHeight || clip.height || 200) * scaleRatio;
          const x = clip.x * scaleRatio;
          const y = clip.y * scaleRatio;

          const fontFam = clip.fontFamily || "NotoSansKR";
          const isBoldRequest =
            String(clip.fontWeight).toLowerCase() === "bold";

          let selectedFontPath;
          if (isBoldRequest && FONT_PATHS[fontFam]?.bold) {
            selectedFontPath = FONT_PATHS[fontFam].bold;
          } else {
            selectedFontPath =
              FONT_PATHS[fontFam]?.normal || FONT_PATHS["NotoSansKR"].normal;
          }

          if (!fs.existsSync(selectedFontPath)) {
            selectedFontPath = FONT_PATHS["NotoSansKR"].normal;
          }

          const escapedFontPath = selectedFontPath
            .replace(/\\/g, "/")
            .replace(/:/g, "\\:");

          let xPos = `(w-text_w)/2`;
          if (clip.textAlign === "left") xPos = `0`;
          else if (clip.textAlign === "right") xPos = `(w-text_w)`;

          const shadowOpt = clip.shadow
            ? ":shadowcolor=black@0.4:shadowx=2:shadowy=2"
            : "";

          // y축 정렬을 (h-text_h)/2 대신 0으로 두어 상단부터 캔버스를 꽉 채우게 함
          const textBaseFilter = `color=c=black@0:s=${Math.round(boxW)}x=${Math.round(boxH)}:d=${clip.duration},drawtext=fontfile='${escapedFontPath}':text='${textContent}':fontcolor=${fontColor}:fontsize=${fontSize}:x=${xPos}:y=(h-text_h)/2:line_spacing=0${shadowOpt}[${textCanvasLabel}]`;
          videoFilters.push(textBaseFilter);

          let textTransform = `[${textCanvasLabel}]format=yuva420p`;

          if (opacity < 1) {
            textTransform += `,colorchannelmixer=aa=${opacity}`;
          }

          if (clip.scaleX === -1) textTransform += `,hflip`;
          if (clip.scaleY === -1) textTransform += `,vflip`;

          let finalX = x - boxW / 2;
          let finalY = y - boxH / 2;

          if (clip.rotation && clip.rotation !== 0) {
            const rad = (clip.rotation * Math.PI) / 180;
            textTransform += `,rotate=${rad}:c=none:ow='hypot(iw,ih)':oh='ow'`;
            const diagonal = Math.sqrt(boxW * boxW + boxH * boxH);
            finalX = x - diagonal / 2;
            finalY = y - diagonal / 2;
          }
          videoFilters.push(`${textTransform}[${textRotateLabel}]`);

          videoFilters.push(
            `[${lastVideoLabel}][${textRotateLabel}]overlay=x=${Math.round(finalX)}:y=${Math.round(finalY)}:enable='between(t,${clip.start},${clip.start + clip.duration})':eof_action=pass:format=auto[${outputLabel}]`,
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
