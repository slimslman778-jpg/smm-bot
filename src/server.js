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
const MAX_DOWNLOAD_MB = Number(process.env.MAX_DOWNLOAD_MB || 500);
const JOB_TIMEOUT_SECONDS =
  Number(process.env.JOB_TIMEOUT_SECONDS || 900);

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing");
  process.exit(1);
}

const app = express();

app.get("/", (_, res) => {
  res.send("✅ Telegram Video Compressor is running.");
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("HTTP server on " + PORT);
});

const bot = new Telegraf(BOT_TOKEN);

const jobs = new Map();

const root = path.join(
  os.tmpdir(),
  "tg-video-compressor"
);

fs.mkdirSync(root, {
  recursive: true
});

function mb(n) {
  return (n / 1048576).toFixed(1);
}

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function validUrl(value) {
  try {
    const u = new URL(value);

    if (
      !["http:", "https:"].includes(
        u.protocol
      )
    ) {
      return null;
    }

    return u;
  } catch {
    return null;
  }
}

function run(
  command,
  args,
  timeout = JOB_TIMEOUT_SECONDS * 1000
) {
  return new Promise(
    (resolve, reject) => {

      const p = spawn(
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

      let out = "";
      let err = "";
      let finished = false;

      function fail(error) {
        if (finished) return;

        finished = true;

        reject(error);
      }

      const timer = setTimeout(
        () => {

          try {
            p.kill("SIGKILL");
          } catch {}

          fail(
            new Error(
              "انتهت مهلة المعالجة."
            )
          );

        },
        timeout
      );

      p.stdout.on(
        "data",
        data => {
          out += data.toString();
        }
      );

      p.stderr.on(
        "data",
        data => {
          err += data.toString();
        }
      );

      p.on(
        "error",
        fail
      );

      p.on(
        "close",
        code => {

          clearTimeout(timer);

          if (finished) return;

          finished = true;

          if (code === 0) {

            resolve({
              out,
              err
            });

          } else {

            reject(
              new Error(
                command +
                " failed (" +
                code +
                ")\n" +
                err.slice(-3500)
              )
            );

          }

        }
      );

    }
  );
}

async function downloadVideo(
  url,
  output
) {

  const u = validUrl(url);

  if (!u) {
    throw new Error(
      "الرابط غير صالح."
    );
  }

  const maxBytes =
    MAX_DOWNLOAD_MB * 1048576;

  await run(
    "yt-dlp",
    [
      "--no-playlist",

      "--no-warnings",

      "-f",
      "bv*+ba/b",

      "--merge-output-format",
      "mp4",

      "-o",
      output,

      u.href
    ]
  );

  const stat =
    await fsp
      .stat(output)
      .catch(() => null);

  if (
    !stat ||
    !stat.size
  ) {

    throw new Error(
      "لم يتم الحصول على ملف فيديو من الرابط."
    );

  }

  if (
    stat.size >
    maxBytes
  ) {

    throw new Error(
      "الفيديو أكبر من الحد التجريبي " +
      MAX_DOWNLOAD_MB +
      " MB."
    );

  }

  return stat.size;
}

async function probe(
  file
) {

  const result =
    await run(
      "ffprobe",
      [
        "-v",
        "error",

        "-show_entries",
        "format=duration,size",

        "-of",
        "json",

        file
      ]
    );

  const data =
    JSON.parse(
      result.out
    );

  return {
    duration:
      Number(
        data.format?.duration ||
        0
      ),

    size:
      Number(
        data.format?.size ||
        0
      )
  };
}

async function compress(
  input,
  output,
  mode
) {

  const args = [

    "-y",

    "-i",
    input,

    "-map",
    "0:v:0",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-pix_fmt",
    "yuv420p",

    "-movflags",
    "+faststart"

  ];

  if (
    mode === "strong"
  ) {

    args.push(

      "-vf",
      "scale='min(854,iw)':-2",

      "-crf",
      "32",

      "-maxrate",
      "800k",

      "-bufsize",
      "1600k"

    );

  }

  else if (
    mode === "quality"
  ) {

    args.push(

      "-vf",
      "scale='min(1280,iw)':-2",

      "-crf",
      "27",

      "-maxrate",
      "2200k",

      "-bufsize",
      "4400k"

    );

  }

  else {

    args.push(

      "-vf",
      "scale='min(960,iw)':-2",

      "-crf",
      "29",

      "-maxrate",
      "1400k",

      "-bufsize",
      "2800k"

    );

  }

  if (
    mode === "mute"
  ) {

    args.push(
      "-an"
    );

  }

  else {

    args.push(

      "-map",
      "0:a?",

      "-c:a",
      "aac",

      "-b:a",
      "96k"

    );

  }

  args.push(
    output
  );

  await run(
    "ffmpeg",
    args
  );
}

function keyboard() {

  return Markup.inlineKeyboard([

    [
      Markup.button.callback(
        "🟢 أقصى ضغط",
        "c:strong"
      )
    ],

    [
      Markup.button.callback(
        "🟡 ضغط متوازن",
        "c:balanced"
      )
    ],

    [
      Markup.button.callback(
        "🔵 جودة أفضل",
        "c:quality"
      )
    ],

    [
      Markup.button.callback(
        "🔇 بدون صوت",
        "c:mute"
      )
    ]

  ]);

}

bot.start(
  ctx => {

    ctx.reply(

      "🎬 أهلاً بك في بوت توفير الإنترنت وضغط الفيديو.\n\n" +

      "أرسل رابط فيديو عام من YouTube أو منصة يدعمها yt-dlp.\n\n" +

      "سأقوم بتنزيل الفيديو ثم ضغطه فعليًا بواسطة FFmpeg وإرسال النسخة المضغوطة لك.\n\n" +

      "⚠️ لا يمكن تجاوز DRM أو تسجيل الدخول."

    );

  }
);

bot.on(
  "text",
  async ctx => {

    const text =
      ctx.message.text.trim();

    if (
      text.startsWith("/")
    ) {
      return;
    }

    const u =
      validUrl(text);

    if (!u) {

      return ctx.reply(
        "❌ أرسل رابطًا صحيحًا يبدأ بـ http:// أو https://"
      );

    }

    jobs.set(
      ctx.from.id,
      {
        url: u.href
      }
    );

    await ctx.reply(

      "🔗 تم استلام الرابط.\n\n" +

      "اختر طريقة الضغط:",

      keyboard()

    );

  }
);

bot.action(
  /^c:(strong|balanced|quality|mute)$/,
  async ctx => {

    const job =
      jobs.get(
        ctx.from.id
      );

    if (!job) {

      return ctx.answerCbQuery(
        "أرسل الرابط أولًا."
      );

    }

    const mode =
      ctx.match[1];

    await ctx.answerCbQuery(
      "بدأت المعالجة..."
    );

    const status =
      await ctx.reply(
        "⏳ جاري تنزيل الفيديو من الرابط..."
      );

    const id =
      uid();

    const dir =
      path.join(
        root,
        id
      );

    const input =
      path.join(
        dir,
        "source.mp4"
      );

    const output =
      path.join(
        dir,
        "compressed.mp4"
      );

    await fsp.mkdir(
      dir,
      {
        recursive: true
      }
    );

    try {

      const downloaded =
        await downloadVideo(
          job.url,
          input
        );

      const source =
        await probe(
          input
        );

      await ctx.telegram.editMessageText(

        ctx.chat.id,

        status.message_id,

        undefined,

        `📥 تم التنزيل.\n\n` +

        `📦 الحجم الأصلي: ${mb(downloaded)} MB\n\n` +

        `⚙️ جاري الضغط الحقيقي بواسطة FFmpeg...`

      );

      await compress(
        input,
        output,
        mode
      );

      const out =
        await fsp.stat(
          output
        );

      const saved =
        Math.max(
          0,
          source.size -
          out.size
        );

      const percentage =
        source.size
          ? (
              saved /
              source.size
            ) * 100
          : 0;

      await ctx.telegram.editMessageText(

        ctx.chat.id,

        status.message_id,

        undefined,

        `✅ اكتمل الضغط!\n\n` +

        `📦 قبل: ${mb(source.size)} MB\n` +

        `📉 بعد: ${mb(out.size)} MB\n` +

        `💾 تم توفير: ${percentage.toFixed(1)}%\n\n` +

        `📤 جاري إرسال الفيديو...`

      );

      await ctx.replyWithVideo(

        {
          source: output
        },

        {
          caption:

            `🎬 الفيديو المضغوط\n\n` +

            `📦 ${mb(source.size)} MB → ${mb(out.size)} MB\n` +

            `💾 توفير ${percentage.toFixed(1)}%`

        }

      );

      await ctx.telegram
        .deleteMessage(
          ctx.chat.id,
          status.message_id
        )
        .catch(() => {});

    }

    catch (error) {

      console.error(
        error
      );

      await ctx.telegram
        .editMessageText(

          ctx.chat.id,

          status.message_id,

          undefined,

          `❌ لم أستطع معالجة الرابط.\n\n` +

          String(
            error.message
          ).slice(
            0,
            1200
          )

        )
        .catch(() => {});

    }

    finally {

      jobs.delete(
        ctx.from.id
      );

      await fsp.rm(
        dir,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});

    }

  }
);

bot.catch(
  error =>
    console.error(
      "Bot error:",
      error
    )
);

bot.launch().then(
  () =>
    console.log(
      "🤖 Bot started."
    )
);

process.once(
  "SIGINT",
  () =>
    bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () =>
    bot.stop("SIGTERM")
);
