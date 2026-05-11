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
    $(
      "script, style, iframe, noscript, svg, link, header, footer, nav, aside",
    ).remove();

    res.json({
      html: $("body").html(),
    });
  } catch (error) {
    res.status(500).json({ error: "콘텐츠 추출 실패: " + error.message });
  }
});

app.post("/convert-tone", async (req, res) => {
  try {
    const { lines, tone } = req.body;
    if (!lines || !Array.isArray(lines) || !tone)
      return res.status(400).json({ error: "데이터가 부족합니다." });

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

    const prompt = `당신은 숏폼 영상 자막을 제작하는 전문 편집자입니다. 
    입력된 문장 배열의 각 요소를 자연스러운 '${tone}'으로 변환하세요.
    
    [준수 사항]
    1. 각 입력 문장은 영상의 한 장면(자막)에 해당합니다. 절대로 여러 문장을 하나로 합치거나 흐름을 임의로 연결하지 마세요.
    2. 입력 배열의 개수와 출력 배열의 개수는 반드시 일치해야 합니다.
    3. 문장의 의미는 유지하되, 자막 특성상 너무 길지 않게 핵심 어조만 변경하세요.
    4. 응답은 반드시 JSON 형식을 유지하세요: { "convertedLines": ["변환문장1", "변환문장2", ...] }
    
    문장 목록:
    ${JSON.stringify(lines)}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let resultText = response.text();

    const jsonMatch = resultText.match(/\{.*\}/s);
    if (!jsonMatch) throw new Error("AI 응답 형식이 올바르지 않습니다.");

    const parsedData = JSON.parse(jsonMatch[0]);
    res.json({ convertedLines: parsedData.convertedLines });
  } catch (error) {
    res.status(500).json({ error: "어조 변환 실패: " + error.message });
  }
});

app.post("/generate-image-prompts", async (req, res) => {
  try {
    const { lines } = req.body;
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

    const prompt = `당신은 영상 제작을 위한 아트 디렉터입니다. 
    제공된 문장 목록은 하나의 영상 흐름입니다. 전체 맥락을 유지하면서, 각 문장과 완벽히 매치되는 이미지 생성용 영문 프롬프트를 작성하세요.
    
    [요구 사항]
    1. 전체 영상의 비주얼 스타일이 일관되어야 합니다.
    2. 각 프롬프트는 1:1 비율 이미지 생성에 최적화된 구체적인 영문 묘사를 포함해야 합니다.
    3. 응답은 반드시 JSON 형식이어야 합니다: { "prompts": ["prompt 1", "prompt 2", ...] }
    4. 입력 배열의 개수(${lines.length}개)와 출력 프롬프트 배열의 개수는 반드시 일치해야 합니다.

    문장 목록:
    ${JSON.stringify(lines)}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const jsonMatch = response.text().match(/\{.*\}/s);
    if (!jsonMatch) throw new Error("프롬프트 생성 실패");

    res.json(JSON.parse(jsonMatch[0]));
  } catch (error) {
    res.status(500).json({ error: "프롬프트 생성 오류: " + error.message });
  }
});

app.post("/generate-images-batch", async (req, res) => {
  try {
    const { prompts, projectId } = req.body;
    const imageUrls = [];

    for (let i = 0; i < prompts.length; i++) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      const result = await genAI
        .getGenerativeModel({ model: "gemini-3.1-flash-image-preview" })
        .generateContent({
          contents: [{ role: "user", parts: [{ text: prompts[i] }] }],
        });

      const response = await result.response;

      let base64Data = null;
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          base64Data = part.inlineData.data;
          break;
        }
      }

      if (!base64Data) {
        throw new Error(`${i}번째 이미지 데이터를 찾을 수 없습니다.`);
      }

      const buffer = Buffer.from(base64Data, "base64");
      const fileName = `gen_${projectId}_${i}_${Date.now()}.png`;
      const filePath = `generated/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from("project-assets")
        .upload(filePath, buffer, { contentType: "image/png" });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from("project-assets")
        .getPublicUrl(filePath);

      imageUrls.push(urlData.publicUrl);
    }

    res.json({ imageUrls });
  } catch (error) {
    res.status(500).json({ error: "이미지 생성 실패: " + error.message });
  }
});

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
        // 수정 부분: "shape" 타입을 렌더링 대상에 추가합니다.
        if (["video", "image", "text", "shape"].includes(clip.type)) {
          const inputIdx = currentInputIndex++;
          let currentInputPath = clip.url;

          // 수정 부분: "shape" 타입도 "text"와 마찬가지로 클라이언트에서 생성한 이미지를 파일로 저장하여 사용합니다.
          if (
            (clip.type === "text" || clip.type === "shape") &&
            clip.textImage
          ) {
            const imgType = clip.type === "text" ? "text" : "shape";
            const textImgPath = path.join(
              tempDir,
              `${imgType}_${filterCounter}.png`,
            );
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
          // 수정 부분: shape 타입도 realHeight를 사용하여 이미지 비율을 정확히 맞춥니다.
          const h = Math.round(
            (clip.type === "text" || clip.type === "shape"
              ? clip.realHeight
              : clip.height) * scaleRatio,
          );

          let targetW = w;
          let targetH = h;
          let finalX = clip.x * scaleRatio - w / 2;
          let finalY = clip.y * scaleRatio - h / 2;

          // 수정 부분: shape 타입도 클라이언트에서 적용된 패딩값을 보정하여 렌더링 위치를 맞춥니다.
          if (clip.type === "text" || clip.type === "shape") {
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
