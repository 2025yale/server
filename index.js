const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

app.use(express.json());

app.post("/render", async (req, res) => {
  try {
    const { projectId, tracks, settings, socketId } = req.body;
    const socket = io.sockets.sockets.get(socketId);

    const tempDir = path.join(__dirname, "temp", projectId);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const outputPath = path.join(tempDir, "output.mp4");

    const { width = 1080, height = 1920, duration = 10 } = settings;

    // FFmpeg 명령 생성
    let command = ffmpeg();

    // 1. 배경 설정 (검은색 배경)
    command
      .input(`color=c=black:s=${width}x${height}:d=${duration}`)
      .inputOptions("-f lavfi");

    const filterComplex = [];
    let inputCount = 1; // 0번은 배경

    // 2. 트랙 및 클립 처리
    tracks.forEach((track) => {
      if (!track.visible) return;
      track.clips.forEach((clip) => {
        if (clip.type === "video" || clip.type === "image") {
          command.input(clip.url);
          const idx = inputCount++;

          // 레이어 합성 필터 (위치, 크기, 시작시간, 투명도 반영)
          // 텍스트 클립은 drawtext로 별도 처리하므로 제외
          let filter = `[${idx}:v]scale=${clip.width}:${clip.height}`;
          if (clip.opacity < 100) {
            filter += `,format=yuva420p,colorchannelmixer=aa=${clip.opacity / 100}`;
          }
          filter += `[v${idx}];`;
          filter += `[${idx === 1 ? "0" : "tmp"}]v${idx}]overlay=x=${clip.x - clip.width / 2}:y=${clip.y - clip.height / 2}:enable='between(t,${clip.start},${clip.start + clip.duration})'[tmp]`;
          filterComplex.push(filter);
        } else if (clip.type === "text") {
          // 텍스트 처리 (기본 폰트 사용)
          const textFilter = `drawtext=text='${clip.text}':fontcolor=${clip.textColor}:fontsize=${clip.fontSize}:x=${clip.x - clip.width / 2}:y=${clip.y - clip.height / 2}:enable='between(t,${clip.start},${clip.start + clip.duration})'`;
          filterComplex.push(
            `[${filterComplex.length === 0 ? "0" : "tmp"}]${textFilter}[tmp]`,
          );
        } else if (clip.type === "audio") {
          command.input(clip.url);
          // 오디오 믹싱 로직 (생략 가능하나 구조 유지를 위해 idx만 증가)
          inputCount++;
        }
      });
    });

    // 필터 연결 및 출력 설정
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
            console.log("Rendering finished. Checking file...");

            // 파일 안정성 확인 (0MB 방지)
            if (
              !fs.existsSync(outputPath) ||
              fs.statSync(outputPath).size === 0
            ) {
              throw new Error("Rendered file is empty.");
            }

            const fileContent = fs.readFileSync(outputPath);
            const fileName = `render_${projectId}_${Date.now()}.mp4`;

            // Supabase 업로드
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

            // 임시 파일 정리 및 완료 알림
            fs.rmSync(tempDir, { recursive: true, force: true });
            if (socket) socket.emit("render-complete", { url: publicUrl });

            resolve();
          } catch (err) {
            reject(err);
          }
        })
        .outputOptions("-t", duration.toString()) // 전체 길이 제한
        .save(outputPath);
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Render error:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
