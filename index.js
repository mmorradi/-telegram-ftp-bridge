// ========================================================
//  Telegram–FTP Bridge  (Stream‑to‑FTP Architecture)
//  Author : Meysam Moradi + GapGPT
//  Version: Final stable for Render (409‑safe, Proxy‑ready)
// ========================================================

import { Telegraf, Markup } from "telegraf";
import axios from "axios";
import ftp from "basic-ftp";
import express from "express";
import dotenv from "dotenv";
import HttpsProxyAgent from "https-proxy-agent";

// ---------- Load Environment Variables ----------
dotenv.config();

// ---------- Debug BOT_TOKEN ----------
console.log("DEBUG BOT_TOKEN:", process.env.BOT_TOKEN ? "✅ Loaded" : "❌ Missing");

// ---------- Init Bot ----------
const bot = new Telegraf(process.env.BOT_TOKEN);

// ========================================================
//  Telegram File → FTP Stream Uploader
// ========================================================
async function uploadToFTP(fileStream, filename) {
  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASS,
      secure: false,
    });

    const destPath = process.env.FTP_PATH
      ? `${process.env.FTP_PATH}/${filename}`
      : filename;
    console.log(`[FTP] Connected. Uploading ${destPath} ...`);

    await client.uploadFrom(fileStream, destPath);
    console.log(`[FTP] ✅ Upload completed: ${destPath}`);
  } catch (err) {
    console.error(`[FTP] ❌ Error uploading: ${err.message}`);
    throw err;
  } finally {
    client.close();
  }
}

// ========================================================
//  Bot Handlers
// ========================================================

// دستور /start
bot.start((ctx) => {
  ctx.reply(
    "سلام میثم 👋\nربات فعال است ✅\nفایل بفرست تا مستقیماً به FTP استریم شود."
  );
});

// هندلر عمومی برای دیباگ نوع پیام‌ها
bot.on("message", (ctx) => {
  if (ctx.message) {
    const keys = Object.keys(ctx.message);
    console.log("🧠 Received message keys:", keys);
  }
});

// هندل ارسال انواع فایل‌ (document/photo/video/audio)
bot.on(["document", "photo", "video", "audio"], async (ctx) => {
  let fileId, filename;

  // استخراج نوع فایل
  if (ctx.message.document) {
    fileId = ctx.message.document.file_id;
    filename = ctx.message.document.file_name;
  } else if (ctx.message.photo) {
    const photos = ctx.message.photo;
    fileId = photos[photos.length - 1].file_id;
    filename = `photo_${fileId}.jpg`;
  } else if (ctx.message.video) {
    fileId = ctx.message.video.file_id;
    filename = ctx.message.video.file_name || `video_${fileId}.mp4`;
  } else if (ctx.message.audio) {
    fileId = ctx.message.audio.file_id;
    filename = ctx.message.audio.file_name || `audio_${fileId}.mp3`;
  } else {
    console.log("📂 Unknown media type");
    return ctx.reply("نوع فایل پشتیبانی نمی‌شود.");
  }

  console.log(`📦 Received: ${filename}`);

  try {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    console.log("[DEBUG] fileLink:", fileLink.href);

    // اگر تلگرام در region فعلی فیلتر بود، از proxy استفاده کن
    const proxyAgent = process.env.TELEGRAM_PROXY
      ? new HttpsProxyAgent(process.env.TELEGRAM_PROXY)
      : undefined;

    // Stream از تلگرام
    const response = await axios.get(fileLink.href, {
      responseType: "stream",
      httpsAgent: proxyAgent,
    });

    // Upload به FTP
    await uploadToFTP(response.data, filename);

    const publicUrl =
      process.env.FTP_PUBLIC_URL
        ? `${process.env.FTP_PUBLIC_URL}/${filename}`
        : filename;

    await ctx.reply(
      `✅ فایل ${filename}\nبا موفقیت روی FTP آپلود شد.\n${publicUrl}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🗑 حذف از FTP", `delete_${filename}`)],
      ])
    );
  } catch (err) {
    console.error(`[BOT] ❌ Error processing file: ${err.message}`);
    ctx.reply(`خطا در آپلود ${filename}: ${err.message}`);
  }
});

// حذف فایل از FTP
bot.action(/delete_(.+)/, async (ctx) => {
  const filename = ctx.match[1];
  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASS,
      secure: false,
    });
    const destPath = process.env.FTP_PATH
      ? `${process.env.FTP_PATH}/${filename}`
      : filename;
    await client.remove(destPath);
    console.log(`[FTP] 🗑 Deleted: ${destPath}`);
    await ctx.editMessageText(`🗑 فایل ${filename} حذف شد.`);
  } catch (err) {
    console.error(`[FTP] ❌ Error deleting file: ${err.message}`);
    await ctx.reply(`خطا در حذف فایل: ${err.message}`);
  } finally {
    client.close();
  }
});

// ========================================================
//  Webhook Reset → Prevent 409 Conflict and Start Bot
// ========================================================
bot.telegram
  .getWebhookInfo()
  .then((info) => {
    console.log("Current webhook:", info.url || "none");
    return bot.telegram.deleteWebhook({ drop_pending_updates: true });
  })
  .then(() => {
    console.log("Webhook deleted. Launching bot...");
    return bot.launch({ allowedUpdates: ["message", "callback_query"] });
  })
  .then(() => console.log("🚀 Telegram‑FTP Bridge Stream mode started..."))
  .catch((err) => console.error("❌ Error launching bot:", err));

// ========================================================
//  Render Keep‑Alive HTTP server
// ========================================================
const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("🌐 Telegram‑FTP Bridge active and running!");
});

app.listen(PORT, () => {
  console.log(`🌐 Render keep‑alive HTTP server on port ${PORT}`);
});

// ========================================================
//  Graceful Shutdown
// ========================================================
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
