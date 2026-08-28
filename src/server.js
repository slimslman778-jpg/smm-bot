const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);

const MAX_DOWNLOAD_MB = Number(
  process.env.MAX_DOWNLOAD_MB || 500
);

const JOB_TIMEOUT_SECONDS = Number(
  process.env.JOB_TIMEOUT_SECONDS || 900
);

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN غير موجود في Environment Variables");
  process.exit(1);
}

const app = express();

app.get("/", (req, res) => {
  res.send("✅ بوت ضغط الفيديو يعمل بنجاح");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "telegram-video-compressor"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 HTTP server on ${PORT}`);
});

const bot = new Telegraf(BOT_TOKEN);

const jobs = new Map();

const ROOT = path.join(
  os.tmpdir(),
  "telegram-video-compressor"
);

fs.mkdirSync(ROOT, {
  recursive: true
});

function mb(bytes) {
  return (bytes / 1048576).toFixed(1);
}

function makeId() {
  return crypto
    .randomBytes(8)
    .toString("hex");
}

function validUrl(value) {
  try {
    const url = new URL(value);

    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

function isYouTube(url) {
  try {
    const host = new URL(url).hostname
      .toLowerCase()
      .replace(/^www\./, "");

    return (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtu.be" ||
      host === "music.youtube.com"
    );
  } catch {
    return false;
  }
}

function run(command, args, timeoutMs) {
  const timeout =
    timeoutMs ||
    JOB_TIMEOUT_SECONDS * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      args,
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe"
        ]
      }
    );

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;

      try {
        child.kill("SIGKILL");
      } catch {}

      finished = true;

      reject(
        new Error(
          "انتهت مهلة معالجة الفيديو."
        )
      );
    }, timeout);

    child.stdout.on("data", data => {
      stdout += data.toString();
    });

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", error => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      reject(error);
    });

    child.on("close", code => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve({
          stdout,
          stderr
        });
        return;
      }

      reject(
        new Error(
          `${command} failed (${code})\n` +
          stderr.slice(-5000)
        )
      );
    });
  });
}

/*
 * ----------------------------------------------------
 * yt-dlp arguments
 * ----------------------------------------------------
 */

function ytDlpBaseArgs() {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--ignore-config"
  ];

  /*
   * إذا وضعنا ملف Cookies في Environment Variable
   * يمكن استخدامه بدون وضعه داخل GitHub.
   *
   * YT_COOKIES_FILE=/app/cookies.txt
   */
  if (process.env.YT_COOKIES_FILE) {
    args.push(
      "--cookies",
      process.env.YT_COOKIES_FILE
    );
  }

  /*
   * User-Agent اختياري.
   */
  if (process.env.YT_USER_AGENT) {
    args.push(
      "--user-agent",
      process.env.YT_USER_AGENT
    );
  }

  return args;
}

/*
 * نحاول أكثر من YouTube client.
 * هذا لا يتجاوز DRM أو المحتوى الخاص.
 */
function youtubeClientArgs() {
  return [
    "--extractor-args",
    "youtube:player-client=web_embedded,tv"
  ];
}

/*
 * ----------------------------------------------------
 * استخراج معلومات الفيديو
 * ----------------------------------------------------
 */

async function getVideoInfo(url) {
  const attempts = [];

  /*
   * المحاولة الأولى:
   * web_embedded + tv
   */
  attempts.push([
    ...ytDlpBaseArgs(),
    ...youtubeClientArgs(),
    "--dump-single-json",
    "--skip-download",
    url
  ]);

  /*
   * المحاولة الثانية:
   * الإعداد الافتراضي لـ yt-dlp
   */
  attempts.push([
    ...ytDlpBaseArgs(),
    "--dump-single-json",
    "--skip-download",
    url
  ]);

  let lastError = null;

  for (const args of attempts) {
    try {
      const result = await run(
        "yt-dlp",
        args,
        120000
      );

      const data =
        JSON.parse(result.stdout);

      return data;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ||
    new Error(
      "تعذر استخراج معلومات الفيديو."
    );
}

/*
 * ----------------------------------------------------
 * اختيار صيغة الفيديو
 * ----------------------------------------------------
 */

function formatForQuality(quality) {
  switch (quality) {
    case "720":
      return [
        "bv*[height<=720][ext=mp4]+ba[ext=m4a]/",
        "bv*[height<=720]+ba/",
        "b[height<=720][ext=mp4]/",
        "b[height<=720]/b"
      ].join("");

    case "480":
      return [
        "bv*[height<=480][ext=mp4]+ba[ext=m4a]/",
        "bv*[height<=480]+ba/",
        "b[height<=480][ext=mp4]/",
        "b[height<=480]/b"
      ].join("");

    case "360":
      return [
        "bv*[height<=360][ext=mp4]+ba[ext=m4a]/",
        "bv*[height<=360]+ba/",
        "b[height<=360][ext=mp4]/",
        "b[height<=360]/b"
      ].join("");

    case "240":
      return [
        "bv*[height<=240][ext=mp4]+ba[ext=m4a]/",
        "bv*[height<=240]+ba/",
        "b[height<=240][ext=mp4]/",
        "b[height<=240]/b"
      ].join("");

    default:
      return "bv*+ba/b";
  }
}

/*
 * ----------------------------------------------------
 * تنزيل الفيديو
 * ----------------------------------------------------
 */

async function downloadVideo(
  url,
  output,
  quality
) {
  const valid = validUrl(url);

  if (!valid) {
    throw new Error(
      "❌ الرابط غير صالح."
    );
  }

  const maxBytes =
    MAX_DOWNLOAD_MB *
    1048576;

  const args = [
    ...ytDlpBaseArgs()
  ];

  if (isYouTube(url)) {
    args.push(
      ...youtubeClientArgs()
    );
  }

  args.push(
    "-f",
    formatForQuality(quality),

    "--merge-output-format",
    "mp4",

    "--retries",
    "3",

    "--fragment-retries",
    "3",

    "--concurrent-fragments",
    "2",

    "-o",
    output,

    url
  );

  await run(
    "yt-dlp",
    args,
    JOB_TIMEOUT_SECONDS * 1000
  );

  const stat =
    await fsp
      .stat(output)
      .catch(() => null);

  if (!stat || !stat.size) {
    throw new Error(
      "لم يتم الحصول على ملف فيديو."
    );
  }

  if (stat.size > maxBytes) {
    throw new Error(
      `الفيديو الأصلي أكبر من الحد المسموح ${MAX_DOWNLOAD_MB} MB.`
    );
  }

  return stat.size;
}

/*
 * ----------------------------------------------------
 * معلومات الملف
 * ----------------------------------------------------
 */

async function probe(file) {
  const result = await run(
    "ffprobe",
    [
      "-v",
      "error",

      "-show_entries",
      "format=duration,size",

      "-of",
      "json",

      file
    ],
    60000
  );

  const data =
    JSON.parse(result.stdout);

  return {
    duration:
      Number(
        data.format?.duration || 0
      ),

    size:
      Number(
        data.format?.size || 0
      )
  };
}

/*
 * ----------------------------------------------------
 * ضغط الفيديو
 * ----------------------------------------------------
 */

async function compressVideo(
  input,
  output,
  quality
) {
  let width = 960;
  let crf = 29;
  let audioBitrate = "96k";

  if (quality === "720") {
    width = 1280;
    crf = 27;
  }

  if (quality === "480") {
    width = 854;
    crf = 29;
  }

  if (quality === "360") {
    width = 640;
    crf = 31;
  }

  if (quality === "240") {
    width = 426;
    crf = 33;
    audioBitrate = "64k";
  }

  const args = [
    "-y",

    "-i",
    input,

    "-map",
    "0:v:0",

    "-vf",
    `scale='min(${width},iw)':-2`,

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-crf",
    String(crf),

    "-pix_fmt",
    "yuv420p",

    "-movflags",
    "+faststart",

    "-map",
    "0:a?",

    "-c:a",
    "aac",

    "-b:a",
    audioBitrate,

    output
  ];

  await run(
    "ffmpeg",
    args,
    JOB_TIMEOUT_SECONDS * 1000
  );
}

/*
 * ----------------------------------------------------
 * ضغط تلقائي إلى أقل من 45MB قدر الإمكان
 * ----------------------------------------------------
 */

async function compressAuto(
  input,
  output,
  duration
) {
  const TARGET_MB = 45;

  if (!duration || duration <= 0) {
    return compressVideo(
      input,
      output,
      "480"
    );
  }

  /*
   * نترك مساحة بسيطة للصوت والحاوية.
   */
  const targetBits =
    TARGET_MB *
    1024 *
    1024 *
    8 *
    0.94;

  const audioKbps = 64;

  let videoKbps =
    Math.floor(
      targetBits /
      duration /
      1000
    ) - audioKbps;

  videoKbps = Math.max(
    150,
    Math.min(
      videoKbps,
      2500
    )
  );

  const args = [
    "-y",

    "-i",
    input,

    "-map",
    "0:v:0",

    "-vf",
    "scale='min(854,iw)':-2",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-b:v",
    `${videoKbps}k`,

    "-maxrate",
    `${videoKbps}k`,

    "-bufsize",
    `${videoKbps * 2}k`,

    "-map",
    "0:a?",

    "-c:a",
    "aac",

    "-b:a",
    `${audioKbps}k`,

    "-movflags",
    "+faststart",

    output
  ];

  await run(
    "ffmpeg",
    args,
    JOB_TIMEOUT_SECONDS * 1000
  );
}

/*
 * ----------------------------------------------------
 * MP3
 * ----------------------------------------------------
 */

async function downloadAudio(
  url,
  output
) {
  const args = [
    ...ytDlpBaseArgs()
  ];

  if (isYouTube(url)) {
    args.push(
      ...youtubeClientArgs()
    );
  }

  args.push(
    "-f",
    "ba/b",

    "--extract-audio",

    "--audio-format",
    "mp3",

    "--audio-quality",
    "128K",

    "-o",
    output,

    url
  );

  await run(
    "yt-dlp",
    args,
    JOB_TIMEOUT_SECONDS * 1000
  );

  const stat =
    await fsp
      .stat(output)
      .catch(() => null);

  if (!stat || !stat.size) {
    throw new Error(
      "تعذر استخراج الصوت."
    );
  }

  return stat.size;
}

/*
 * ----------------------------------------------------
 * لوحة الجودة
 * ----------------------------------------------------
 */

function qualityKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🎬 HD 720p",
        "q:720"
      ),
      Markup.button.callback(
        "📺 SD 480p ⭐",
        "q:480"
      )
    ],

    [
      Markup.button.callback(
        "📉 Low 360p",
        "q:360"
      ),
      Markup.button.callback(
        "📱 Mobile 240p",
        "q:240"
      )
    ],

    [
      Markup.button.callback(
        "⚡ ضغط تلقائي (<45MB)",
        "q:auto"
      ),
      Markup.button.callback(
        "🎵 صوت فقط (MP3)",
        "q:mp3"
      )
    ],

    [
      Markup.button.callback(
        "❌ إلغاء العملية",
        "q:cancel"
      )
    ]
  ]);
}

/*
 * ----------------------------------------------------
 * /start
 * ----------------------------------------------------
 */

bot.start(async ctx => {
  await ctx.reply(
    "👋 مرحباً بك في بوت تحميل وضغط الفيديوهات 🎬\n\n" +

    "📌 أرسل رابط الفيديو فقط.\n\n" +

    "🌐 يدعم الروابط العامة من المواقع التي يدعمها yt-dlp.\n\n" +

    "بعد إرسال الرابط سأقوم بفحص الفيديو وإظهار:\n" +

    "• 🎬 العنوان\n" +
    "• ⏱️ المدة\n" +
    "• 📐 الدقة\n" +
    "• 📦 الحجم التقريبي\n" +

    "\nثم تختار الجودة التي تريدها.\n\n" +

    "🚀 بعدها يتم التنزيل والضغط بواسطة FFmpeg."
  );
});

/*
 * ----------------------------------------------------
 * استقبال الرابط
 * ----------------------------------------------------
 */

bot.on("text", async ctx => {
  const text =
    ctx.message.text.trim();

  if (text.startsWith("/")) {
    return;
  }

  const url = validUrl(text);

  if (!url) {
    return ctx.reply(
      "❌ أرسل رابط فيديو صحيح يبدأ بـ http:// أو https://"
    );
  }

  /*
   * منع المستخدم من تشغيل أكثر من عملية
   */
  if (jobs.has(ctx.from.id)) {
    return ctx.reply(
      "⏳ لديك عملية قيد التنفيذ بالفعل. انتظر حتى تنتهي."
    );
  }

  const status =
    await ctx.reply(
      "🔎 جاري فحص الفيديو واستخراج معلوماته..."
    );

  try {
    const info =
      await getVideoInfo(
        url.href
      );

    const duration =
      Number(info.duration || 0);

    const width =
      Number(info.width || 0);

    const height =
      Number(info.height || 0);

    const size =
      Number(info.filesize || info.filesize_approx || 0);

    const title =
      String(
        info.title ||
        "فيديو بدون عنوان"
      );

    const uploader =
      String(
        info.uploader ||
        info.channel ||
        "غير معروف"
      );

    jobs.set(
      ctx.from.id,
      {
        url: url.href,
        info
      }
    );

    const minutes =
      Math.floor(duration / 60);

    const seconds =
      Math.floor(duration % 60)
        .toString()
        .padStart(2, "0");

    const durationText =
      duration
        ? `${minutes}:${seconds}`
        : "غير معروف";

    const resolution =
      width && height
        ? `${width}x${height}`
        : "غير معروف";

    const sizeText =
      size
        ? `${mb(size)} MB`
        : "غير معروف";

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,

      "📹 تفاصيل الفيديو المطلوبة:\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +

      `📌 العنوان: ${title.slice(0, 500)}\n\n` +

      `⏱️ المدة: ${durationText}\n\n` +

      `📐 الدقة الأصلية: ${resolution}\n\n` +

      `📦 الحجم التقريبي: ${sizeText}\n\n` +

      `👤 الناشر: ${uploader.slice(0, 200)}\n\n` +

      "━━━━━━━━━━━━━━━━━━\n\n" +

      "👇 اختر الجودة وطريقة الضغط المطلوبة:"
      ,
      qualityKeyboard()
    );

  } catch (error) {
    console.error(
      "INFO ERROR:",
      error
    );

    jobs.delete(
      ctx.from.id
    );

    let message =
      "❌ لم أستطع قراءة الفيديو.";

    const errorText =
      String(
        error.message || ""
      );

    if (
      isYouTube(url.href) &&
      (
        errorText.includes(
          "Sign in to confirm"
        ) ||
        errorText.includes(
          "not a bot"
        ) ||
        errorText.includes(
          "cookies"
        )
      )
    ) {
      message =
        "❌ YouTube رفض طلب التحميل بسبب حماية مكافحة الروبوتات.\n\n" +

        "هذا ليس خطأ في FFmpeg أو البوت نفسه.\n\n" +

        "يمكن تشغيل الفيديوهات التي يسمح YouTube باستخراجها، " +
        "أما الفيديوهات التي تتطلب جلسة/ملفات Cookies فلابد من إعداد Cookies لـ yt-dlp على الخادم.";
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      message
    );
  }
});

/*
 * ----------------------------------------------------
 * اختيار الجودة
 * ----------------------------------------------------
 */

bot.action(
  /^q:(720|480|360|240|auto|mp3|cancel)$/,
  async ctx => {
    const userId =
      ctx.from.id;

    const job =
      jobs.get(userId);

    if (!job) {
      return ctx.answerCbQuery(
        "أرسل رابط فيديو أولاً."
      );
    }

    const mode =
      ctx.match[1];

    if (mode === "cancel") {
      jobs.delete(userId);

      await ctx.answerCbQuery(
        "تم إلغاء العملية."
      );

      return ctx.editMessageText(
        "❌ تم إلغاء العملية."
      );
    }

    await ctx.answerCbQuery(
      "بدأت المعالجة..."
    );

    const workId =
      makeId();

    const dir =
      path.join(
        ROOT,
        workId
      );

    await fsp.mkdir(
      dir,
      {
        recursive: true
      }
    );

    const input =
      path.join(
        dir,
        "source.mp4"
      );

    const output =
      path.join(
        dir,
        mode === "mp3"
          ? "audio.mp3"
          : "compressed.mp4"
      );

    const status =
      await ctx.reply(
        "⏳ جاري تنزيل الفيديو..."
      );

    try {
      let downloadedSize = 0;

      if (mode === "mp3") {
        downloadedSize =
          await downloadAudio(
            job.url,
            output
          );
      } else {
        downloadedSize =
          await downloadVideo(
            job.url,
            input,
            mode === "auto"
              ? "480"
              : mode
          );
      }

      if (mode === "mp3") {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          status.message_id,
          undefined,
          `🎵 تم استخراج الصوت.\n\n📦 الحجم: ${mb(downloadedSize)} MB\n\n📤 جاري إرسال الملف...`
        );

        await ctx.replyWithAudio(
          {
            source: output
          },
          {
            caption:
              "🎵 تم استخراج الصوت وتحويله إلى MP3 بنجاح."
          }
        );

        return;
      }

      const original =
        await probe(input);

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        status.message_id,
        undefined,

        `📥 تم تنزيل الفيديو.\n\n` +

        `📦 الحجم الأصلي: ${mb(original.size)} MB\n\n` +

        `⚙️ جاري الضغط الحقيقي بواسطة FFmpeg...`
      );

      if (mode === "auto") {
        await compressAuto(
          input,
          output,
          original.duration
        );
      } else {
        await compressVideo(
          input,
          output,
          mode
        );
      }

      const compressed =
        await fsp.stat(
          output
        );

      const saved =
        Math.max(
          0,
          original.size -
          compressed.size
        );

      const percent =
        original.size
          ? (
              saved /
              original.size
            ) * 100
          : 0;

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        status.message_id,
        undefined,

        "✅ اكتمل الضغط بنجاح!\n\n" +

        `📦 قبل: ${mb(original.size)} MB\n` +

        `📉 بعد: ${mb(compressed.size)} MB\n` +

        `💾 التوفير: ${percent.toFixed(1)}%\n\n` +

        "📤 جاري إرسال الفيديو..."
      );

      await ctx.replyWithVideo(
        {
          source: output
        },
        {
          supports_streaming: true,

          caption:
            "🎬 الفيديو المضغوط\n\n" +

            `📦 ${mb(original.size)} MB → ${mb(compressed.size)} MB\n` +

            `💾 توفير ${percent.toFixed(1)}%`
        }
      );

      await ctx.telegram.deleteMessage(
        ctx.chat.id,
        status.message_id
      ).catch(() => {});

    } catch (error) {
      console.error(
        "PROCESS ERROR:",
        error
      );

      const errorText =
        String(
          error.message || ""
        );

      let message =
        "❌ لم أستطع معالجة الفيديو.";

      if (
        isYouTube(job.url) &&
        (
          errorText.includes(
            "Sign in to confirm"
          ) ||
          errorText.includes(
            "not a bot"
          ) ||
          errorText.includes(
            "cookies"
          )
        )
      ) {
        message =
          "❌ YouTube رفض عملية التحميل.\n\n" +

          "🔐 السبب: حماية YouTube من الطلبات الآلية.\n\n" +

          "إذا كان الفيديو عامًا وقابلًا للاستخراج فقد يعمل تلقائيًا، " +

          "أما إذا طلب YouTube تسجيل الدخول أو Cookies فيجب إعداد Cookies لـ yt-dlp على Render.";
      }

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        status.message_id,
        undefined,
        message
      ).catch(() => {});

    } finally {
      jobs.delete(userId);

      await fsp.rm(
        dir,
        {
                    force: true
        }
      ).catch(() => {});
    }
  }
);

// معالجة أخطاء البوت
bot.catch((error) => {
  console.error("❌ Bot error:", error);
});

// تشغيل البوت
bot.launch()
  .then(() => {
    console.log("🤖 Bot started successfully.");
  })
  .catch((error) => {
    console.error("❌ Failed to start bot:", error);
    process.exit(1);
  });

// إيقاف البوت بشكل آمن
process.once("SIGINT", () => {
  console.log("🛑 Stopping bot...");
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  console.log("🛑 Stopping bot...");
  bot.stop("SIGTERM");
});
          recursive: true,
