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
const JOB_TIMEOUT_SECONDS = Number(process.env.JOB_TIMEOUT_SECONDS || 900);

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing.");
  process.exit(1);
}

const app = express();
app.get("/", (_, res) => res.send("✅ Telegram Video Compressor is running."));
app.get("/health", (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));

const bot = new Telegraf(BOT_TOKEN);
const jobs = new Map();
const root = path.join(os.tmpdir(), "tg-video-compressor");
fs.mkdirSync(root, { recursive: true });

function uid() { return crypto.randomBytes(8).toString("hex"); }
function mb(n) { return (n / 1024 / 1024).toFixed(1); }

function safeUrl(value) {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u;
  } catch { return null; }
}

function run(command, args, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = timeoutMs ? setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error("انتهت مهلة المعالجة."));
    }, timeoutMs) : null;

    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("error", e => { if (timer) clearTimeout(timer); reject(e); });
    p.on("close", code => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${command} failed (${code})\n${err.slice(-3000)}`));
    });
  });
}

async function downloadUrl(url, output) {
  const u = safeUrl(url);
  if (!u) throw new Error("الرابط غير صالح.");

  // First try curl because it handles redirects and large binary downloads well.
  const maxBytes = MAX_DOWNLOAD_MB * 1024 * 1024;
  await run("curl", [
    "-L", "--fail", "--silent", "--show-error",
    "--max-time", String(JOB_TIMEOUT_SECONDS),
    "--output", output, u.href
  ], JOB_TIMEOUT_SECONDS * 1000);

  const stat = await fsp.stat(output);
  if (!stat.size) throw new Error("الرابط لم يرجع ملف فيديو.");
  if (stat.size > maxBytes) {
    throw new Error(`الفيديو أكبر من الحد التجريبي ${MAX_DOWNLOAD_MB} MB.`);
  }
  return stat.size;
}

async function probe(input) {
  const r = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size",
    "-of", "json", input
  ]);
  const data = JSON.parse(r.out);
  return {
    duration: Number(data.format?.duration || 0),
    size: Number(data.format?.size || 0)
  };
}

async function compress(input, output, mode) {
  const p = await probe(input);
  const args = [
    "-y", "-i", input,
    "-map", "0:v:0",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart"
  ];

  if (mode === "strong") {
    args.push("-vf", "scale='min(854,iw)':-2", "-crf", "32", "-maxrate", "800k", "-bufsize", "1600k");
  } else if (mode === "quality") {
    args.push("-vf", "scale='min(1280,iw)':-2", "-crf", "27", "-maxrate", "2200k", "-bufsize", "4400k");
  } else {
    args.push("-vf", "scale='min(960,iw)':-2", "-crf", "29", "-maxrate", "1400k", "-bufsize", "2800k");
  }

  if (mode === "mute") {
    args.push("-an");
  } else {
    args.push("-map", "0:a?", "-c:a", "aac", "-b:a", "96k");
  }

  args.push(output);

  await run("ffmpeg", args, JOB_TIMEOUT_SECONDS * 1000);
  return p;
}

function options() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🟢 أقصى ضغط", "compress:strong")],
    [Markup.button.callback("🟡 ضغط متوازن", "compress:balanced")],
    [Markup.button.callback("🔵 جودة أفضل", "compress:quality")],
    [Markup.button.callback("🔇 فيديو بدون صوت", "compress:mute")]
  ]);
}

bot.start(ctx => ctx.reply(
  "🎬 أهلاً بك في بوت ضغط الفيديو.\n\n" +
  "أرسل رابط فيديو عام يمكن تنزيله، وسأقوم بـ:\n" +
  "🔗 تنزيله\n⚙️ ضغطه فعليًا بـ FFmpeg\n📉 تقليل حجمه\n📤 إرساله لك\n\n" +
  "⚠️ الروابط المحمية أو التي تتطلب تسجيل دخول قد لا تعمل."
));

bot.on("text", async ctx => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  const u = safeUrl(text);
  if (!u) {
    return ctx.reply("❌ أرسل رابطًا صحيحًا يبدأ بـ http:// أو https://");
  }

  jobs.set(ctx.from.id, { url: u.href });
  await ctx.reply(
    "🔗 تم استلام الرابط.\n\nاختر طريقة الضغط:",
    options()
  );
});

bot.action(/^compress:(strong|balanced|quality|mute)$/, async ctx => {
  const job = jobs.get(ctx.from.id);
  if (!job) return ctx.answerCbQuery("أرسل رابط الفيديو أولًا.");

  const mode = ctx.match[1];
  await ctx.answerCbQuery("بدأت المعالجة...");

  const status = await ctx.reply(
    "⏳ جاري تنزيل الفيديو من الرابط...\n" +
    "قد يستغرق ذلك وقتًا حسب حجم الفيديو وسرعة المصدر."
  );

  const id = uid();
  const dir = path.join(root, id);
  const input = path.join(dir, "source.bin");
  const output = path.join(dir, "compressed.mp4");
  await fsp.mkdir(dir, { recursive: true });

  try {
    await downloadUrl(job.url, input);
    const source = await probe(input);

    await ctx.telegram.editMessageText(
      ctx.chat.id, status.message_id, undefined,
      `📥 تم تنزيل الفيديو.\n📦 الحجم: ${mb(source.size)} MB\n⏳ جاري الضغط الحقيقي بواسطة FFmpeg...`
    );

    await compress(input, output, mode);
    const out = await fsp.stat(output);
    const saved = Math.max(0, source.size - out.size);
    const pct = source.size ? (saved / source.size) * 100 : 0;

    await ctx.telegram.editMessageText(
      ctx.chat.id, status.message_id, undefined,
      `✅ تم الضغط بنجاح!\n\n` +
      `📦 قبل: ${mb(source.size)} MB\n` +
      `📉 بعد: ${mb(out.size)} MB\n` +
      `💾 التوفير: ${mb(saved)} MB (${pct.toFixed(1)}%)\n\n` +
      `📤 جاري إرسال الفيديو...`
    );

    await ctx.replyWithVideo(
      { source: output },
      {
        caption:
          `🎬 الفيديو المضغوط\n` +
          `📦 ${mb(source.size)} MB → ${mb(out.size)} MB\n` +
          `💾 تم توفير ${pct.toFixed(1)}%`
      }
    );

    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  } catch (e) {
    console.error(e);
    await ctx.telegram.editMessageText(
      ctx.chat.id, status.message_id, undefined,
      `❌ لم أستطع معالجة الرابط.\n\n${String(e.message).slice(0, 1200)}`
    ).catch(() => {});
  } finally {
    jobs.delete(ctx.from.id);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

bot.catch(err => console.error("Bot error:", err));
bot.launch().then(() => console.log("🤖 Telegram bot started."));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
