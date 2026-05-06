const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const cheerio = require("cheerio");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ limit: "200mb", extended: true }));

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// Gemini AI 설정 (모델 식별자 수정)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

// URL 본문 추출 및 AI 가공 엔드포인트
app.post("/extract-content", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL이 누락되었습니다." });

    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: "https://www.google.com/",
      },
      timeout: 5000,
    });

    const $ = cheerio.load(response.data);
    $("script, style, iframe, noscript, svg, path, link").remove();

    // 기본 본문 텍스트 추출 (AI에게 전달할 용도)
    const rawText = $("body")
      .text()
      .replace(/\s\s+/g, " ")
      .trim()
      .substring(0, 4000);

    // Gemini를 이용한 요약 및 자막 생성 (식별자를 gemini-1.5-flash-latest로 변경하여 호환성 확보)
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-latest",
    });
    const prompt = `
      다음 본문 내용을 바탕으로 숏폼 영상에 들어갈 자막을 작성해줘.
      조건:
      1. 각 문장은 반드시 20자 이내로 작성할 것.
      2. 전체 맥락을 알 수 있게 핵심 내용만 요약할 것.
      3. 응답은 반드시 JSON 배열 형태인 ["문장1", "문장2", ...] 형식으로만 보낼 것.
      4. 다른 설명이나 텍스트는 포함하지 말 것.

      본문: ${rawText}
    `;

    const result = await model.generateContent(prompt);
    const aiResponse = result.response.text();

    // JSON 추출 (코드 블록 제거 및 순수 배열 파싱)
    const jsonMatch = aiResponse.match(/\[.*\]/s);
    const captions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    res.json({
      html: $.html(),
      captions: captions,
    });
  } catch (error) {
    // 상세한 에러 로그 출력
    console.error("AI 가공 중 상세 에러:", error);
    res
      .status(500)
      .json({ error: "콘텐츠 추출 및 가공 실패: " + error.message });
  }
});

// 영상 렌더링 로직 (수정하지 않음)
app.post("/render", async (req, res) => {
  try {
    const { projectId, tracks, settings, socketId } = req.body;
    if (!tracks || !Array.isArray(tracks))
      return res.status(400).json({ error: "Tracks missing" });

    const socket = io.sockets.sockets.get(socketId);
    const tempDir = path.join(__dirname, "temp", projectId);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const extension = settings.ext || "mp4";
    const outputPath = path.join(tempDir, `output.${extension}`);

    let maxDuration = 0;
    tracks.forEach((t) =>
      t.clips.forEach(
        (c) => (maxDuration = Math.max(maxDuration, c.start + c.duration)),
      ),
    );
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
      "file,http,https,tcp,tls,crypto,pipe",
    ]);

    const videoFilters = [];
    const audioFilters = [];
    const audioLabels = [];
    let currentInputIndex = 1;
    let lastVideoLabel = "0:v";
    let filterCounter = 0;

    const reversedTracks = [...tracks].reverse();

    for (const track of reversedTracks) {
      if (!track || !track.visible) continue;
      for (const clip of track.clips) {
        filterCounter++;
        if (["video", "image", "text"].includes(clip.type)) {
          const inputIdx = currentInputIndex++;
          let currentInputPath = clip.url;

          if (clip.type === "text" && clip.textImage) {
            const textImgPath = path.join(tempDir, `text_${filterCounter}.png`);
            const base64Data = clip.textImage.replace(
              /^data:image\/png;base64,/,
              "",
            );
            fs.writeFileSync(textImgPath, base64Data, "base64");
            currentInputPath = textImgPath;
          }

          command.input(currentInputPath);
          const scaledLabel = `v${filterCounter}scaled`;
          const outputLabel = `v${filterCounter}out`;

          const w = Math.round(clip.width * scaleRatio);
          const h = Math.round(
            (clip.type === "text" ? clip.realHeight : clip.height) * scaleRatio,
          );

          let targetW = w;
          let targetH = h;
          let finalX = clip.x * scaleRatio - w / 2;
          let finalY = clip.y * scaleRatio - h / 2;

          if (clip.type === "text") {
            const p = (clip.textPadding || 0) * scaleRatio;
            targetW = w + p * 2;
            targetH = h + p * 2;
            finalX -= p;
            finalY -= p;
          }

          let transformArr = [
            `scale=${Math.round(targetW)}:${Math.round(targetH)}`,
            "format=yuva420p",
          ];
          if (clip.scaleX === -1) transformArr.push("hflip");
          if (clip.scaleY === -1) transformArr.push("vflip");

          if (clip.rotation && clip.rotation !== 0) {
            const rad = (clip.rotation * Math.PI) / 180;
            const diagonal = Math.round(Math.sqrt(targetW ** 2 + targetH ** 2));
            const padX = Math.round((diagonal - targetW) / 2);
            const padY = Math.round((diagonal - targetH) / 2);
            transformArr.push(
              `pad=${diagonal}:${diagonal}:${padX}:${padY}:color=black@0`,
              `rotate=${rad}:c=none`,
            );
            finalX -= padX;
            finalY -= padY;
          }

          const transformStr = transformArr.join(",");
          let filter =
            clip.type !== "video"
              ? `[${inputIdx}:v]loop=-1:size=1:start=0,trim=duration=${clip.duration},setpts=PTS-STARTPTS+${clip.start}/TB,${transformStr}`
              : `[${inputIdx}:v]trim=start=0:duration=${clip.duration},setpts=PTS-STARTPTS+${clip.start}/TB,${transformStr}`;

          if (clip.opacity < 100)
            filter += `,colorchannelmixer=aa=${clip.opacity / 100}`;

          videoFilters.push(`${filter}[${scaledLabel}]`);
          videoFilters.push(
            `[${lastVideoLabel}][${scaledLabel}]overlay=x=${Math.round(finalX)}:y=${Math.round(finalY)}:enable='between(t,${clip.start},${clip.start + clip.duration})':eof_action=pass:format=auto[${outputLabel}]`,
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
      finalFilterComplex +=
        (finalFilterComplex ? ";" : "") +
        audioFilters.join(";") +
        `;${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest[aout]`;
    }

    await new Promise((resolve, reject) => {
      let finalCommand = command.complexFilter(finalFilterComplex, [
        lastVideoLabel,
      ]);
      if (audioLabels.length > 0) finalCommand = finalCommand.map("aout");

      finalCommand
        .on("progress", (p) =>
          socket?.emit("render-progress", {
            percent: Math.min(
              99,
              (timeToSeconds(p.timemark) / finalDuration) * 100,
            ),
          }),
        )
        .on("error", reject)
        .on("end", async () => {
          try {
            const fileContent = fs.readFileSync(outputPath);
            const fileName = `render_${projectId}_${Date.now()}.${extension}`;
            await supabase.storage
              .from("exports")
              .upload(fileName, fileContent, {
                contentType:
                  extension === "mp4" ? "video/mp4" : "video/quicktime",
                upsert: true,
              });
            const {
              data: { publicUrl },
            } = supabase.storage.from("exports").getPublicUrl(fileName);
            if (fs.existsSync(tempDir))
              fs.rmSync(tempDir, { recursive: true, force: true });
            socket?.emit("render-complete", { url: publicUrl });
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
          "-movflags",
          "faststart",
        ])
        .save(outputPath);
    });

    if (!res.headersSent) res.json({ success: true });
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
