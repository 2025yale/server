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

// Base64 데이터 전송을 위해 용량 제한 확대
app.use(cors());
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

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

    // 전체 지속 시간 계산
    let maxDuration = 0;
    tracks.forEach((track) => {
      track.clips.forEach((clip) => {
        maxDuration = Math.max(maxDuration, clip.start + clip.duration);
      });
    });
    const finalDuration =
      maxDuration > 0 ? maxDuration : settings.totalDuration || 5;

    // 출력 해상도 및 스케일 비율 계산 (기준: 1080x1920)
    const width = settings.width || 720;
    const height = settings.height || 1280;
    const fps = settings.fps || 24;
    const scaleRatio = height / 1920;

    let command = ffmpeg();

    // 배경 블랙 캔버스 생성
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

    // 레이어 순서대로 처리 (역순)
    const reversedTracks = [...tracks].reverse();

    for (const track of reversedTracks) {
      if (!track || !track.visible || !track.clips) continue;

      const sortedClips = [...track.clips].sort((a, b) => a.start - b.start);

      for (const clip of sortedClips) {
        filterCounter++;

        // 비디오, 이미지, 텍스트(이미지화된 것) 처리
        if (
          clip.type === "video" ||
          clip.type === "image" ||
          clip.type === "text"
        ) {
          const inputIdx = currentInputIndex++;
          let inputSource = clip.url;

          // 텍스트 클립은 전달받은 Base64 데이터를 파일로 저장하여 사용
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

          // 프리뷰 해상도(1080) 대비 현재 출력 해상도 비율 적용
          const w = Math.round(clip.width * scaleRatio);
          const h = Math.round(clip.height * scaleRatio);
          const x = Math.round((clip.x - clip.width / 2) * scaleRatio);
          const y = Math.round((clip.y - clip.height / 2) * scaleRatio);

          let transformArr = [`scale=${w}:${h}`, "format=yuva420p"];

          // 대칭 반전 처리
          if (clip.scaleX === -1) transformArr.push("hflip");
          if (clip.scaleY === -1) transformArr.push("vflip");

          let finalX = x;
          let finalY = y;

          // 회전 처리 (이미지 방식에서도 회전 좌표 보정이 필요함)
          if (clip.rotation && clip.rotation !== 0) {
            const rad = (clip.rotation * Math.PI) / 180;
            const diagonal = Math.round(Math.sqrt(w * w + h * h));
            const padX = Math.round((diagonal - w) / 2);
            const padY = Math.round((diagonal - h) / 2);

            transformArr.push(
              `pad=${diagonal}:${diagonal}:${padX}:${padY}:color=black@0`,
            );
            transformArr.push(`rotate=${rad}:c=none`);

            finalX = x - padX;
            finalY = y - padY;
          }

          const transformStr = transformArr.join(",");

          // 이미지/텍스트는 루프를 돌려 정지 영상으로 처리
          let filter =
            clip.type === "image" || clip.type === "text"
              ? `[${inputIdx}:v]loop=-1:size=1:start=0,trim=duration=${clip.duration},setpts=PTS-STARTPTS+${clip.start}/TB,${transformStr}`
              : `[${inputIdx}:v]trim=start=0:duration=${clip.duration},setpts=PTS-STARTPTS+${clip.start}/TB,${transformStr}`;

          // 투명도 처리
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

          // 비디오 오디오 추출 및 지연 처리
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

    // 필터 컴플렉스 구성
    let finalFilterComplex = videoFilters.join(";");

    if (audioLabels.length > 0) {
      const amixFilter = `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest[aout]`;
      finalFilterComplex +=
        (finalFilterComplex ? ";" : "") +
        audioFilters.join(";") +
        ";" +
        amixFilter;
    }

    // FFmpeg 실행
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

            // Supabase 스토리지 업로드
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

            // 임시 파일 삭제
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
