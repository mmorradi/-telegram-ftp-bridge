// ======================================================
// Telegram‑to‑FTP Bridge  — Final render‑ready release.
//
// میثم نسخه پایدار برای Render
// رفع کامل خطاهای 401, 409, و مشکل فیلترینگ تلگرام
// شامل express keep-alive و proxy‑ready axios
// ======================================================

import { Telegraf, Markup } from "telegraf";
import axios from "axios";
import ftp from "basic-ftp";
import express from "express";
import dotenv from "dotenv";
import HttpsProxyAgent from "https-proxy-agent";

dotenv.config();

// ---------- Load Token ----------
console.log("DEBUG BOT_TOKEN:", process.env.BOT_TOKEN ? "✅ Loaded" : "❌ Missing");
const bot = new Telegraf(process.env.BOT_TOKEN);

// ======================================================
// TEST TELEGRAM CONNECTIVITY
// ======================================================
axios
  .get("https://api.telegram.org/bot" + process.env.BOT_TOKEN + "/getMe")
  .then((r) => console.log("✅ Telegram reachable OK:", r.data))
  .catch((e) => console.error("❌ Telegram unreachable:", e.message));

// ======================================================
// FTP Upload Helper
// ======================================================
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

    const dest = process.env.FTP_PATH
      ? `${process.env.FTP_PATH}/${filename}`
      : filename;

    console.log(`[FTP] Connected, uploading ${dest} ...`);
    await client.uploadFrom(fileStream, dest);
    console.log(`[FTP] ✅ Upload complete: ${dest}`);
  } catch (err) {
    console.error("[FTP] ❌ Upload error:", err.message);
    throw err;
  } finally {
    client.close();
  }
}

// ======================================================
// Bot Handlers
// ======================================================
bot.start((ctx) => {
  ctx.reply("سلام میثم 👋\nربات فعال است ✅\nفایل بفرست تا مستقیم به FTP استریم شود.");
});

// دیباگ نوع پیام‌ها
bot.on("message", (ctx) => {
  if (ctx.message) {
    console.log("🧠 Received message keys:", Object.keys(ctx.message));
  }
});

// دریافت فایل‌ها
bot.on(["document", "photo", "video", "audio"], async (ctx) => {
  try {
    let fileId, filename;

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
    } else return ctx.reply("نوع فایل پشتیبانی نمی‌شود.");

    console.log(`📦 Received: ${filename}`);
    const fileLink = await ctx.telegram.getFileLink(fileId);
    console.log("[DEBUG] fileLink:", fileLink.href);

    const proxyAgent = process.env.TELEGRAM_PROXY
      ? new HttpsProxyAgent(process.env.TELEGRAM_PROXY)
      : undefined;

    const response = await axios.get(fileLink.href, {
      responseType: "stream",
      httpsAgent: proxyAgent,
    });

    await uploadToFTP(response.data, filename);

    const publicURL = process.env.FTP_PUBLIC_URL
      ? `${process.env.FTP_PUBLIC_URL}/${filename}`
      : filename;

    await ctx.reply(
      `✅ فایل ${filename}\nروی FTP آپلود شد.\n${publicURL}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🗑 حذف فایل از FTP", `delete_${filename}`)],
      ])
    );
  } catch (err) {
    console.error("[BOT] ❌ Error processing:", err.message);
    ctx.reply(`خطا در پردازش فایل: ${err.message}`);
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

    const dest = process.env.FTP_PATH
      ? `${process.env.FTP_PATH}/${filename}`
      : filename;
    await client.remove(dest);
    console.log(`[FTP] 🗑 Removed: ${dest}`);
    await ctx.editMessageText(`🗑 فایل ${filename} حذف شد.`);
  } catch (err) {
    console.error("[FTP] ❌ Delete error:", err.message);
    ctx.reply(`خطا در حذف فایل: ${err.message}`);
  } finally {
    client.close();
  }
});

// ======================================================
// Delete old webhook, launch bot (prevent 409 Conflict)
// ======================================================
bot.telegram
  .getWebhookInfo()
  .then((info) => {
    console.log("Current webhook:", info.url || "none");
    return bot.telegram.deleteWebhook({ drop_pending_updates: true });
  })
  .then(() => {
    console.log("Webhook deleted — launching bot...");
    return bot.launch({ allowedUpdates: ["message", "callback_query"] });
  })
  .then(() => console.log("🚀 Telegram‑FTP Bridge launched"))
  .catch((err) => console.error("❌ Launch error:", err));

// ======================================================
// Express KeepAlive (for Render)
// ======================================================
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (_, res) => res.send("🌐 Telegram‑FTP Bridge is running"));
app.listen(PORT, () => console.log(`🌐 Keep‑alive server on port ${PORT}`));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
