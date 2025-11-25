// ========================================================
//  Telegram–FTP Bridge  (Stream‑to‑FTP Architecture)
//  Author: میثم + GapGPT
//  Version: Final stable for Render (409‑safe)
// ========================================================

import { Telegraf, Markup } from "telegraf";
import axios from "axios";
import ftp from "basic-ftp";
import express from "express";
import dotenv from "dotenv";

// ---------- Load Environment Variables ----------
dotenv.config();

// ---------- Debug check BOT_TOKEN ----------
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

    console.log(`[FTP] Connected. Uploading ${filename}...`);
    await client.uploadFrom(fileStream, filename);
    console.log(`[FTP] ✅ Upload completed: ${filename}`);
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
  return ctx.reply(
    "سلام میثم 👋\nربات فعال است ✅\nفایل بفرست تا مستقیماً به FTP استریم شود."
  );
});

// هندل ارسال فایل
bot.on("document", async (ctx) => {
  const file = ctx.message.document;
  const filename = file.file_name;
  console.log(`📦 Received: ${filename}`);

  try {
    const fileLink = await ctx.telegram.getFileLink(file.file_id);
    console.log(`[STREAM] Starting streaming from Telegram → FTP : ${filename}`);

    const response = await axios.get(fileLink.href, { responseType: "stream" });

    await uploadToFTP(response.data, filename);

    await ctx.reply(
      `✅ ${filename}\nبا موفقیت روی FTP آپلود شد.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🗑 حذف از FTP", `delete_${filename}`)],
      ])
    );
  } catch (err) {
    console.error(`[BOT] ❌ Error: ${err.message}`);
    await ctx.reply(`خطا در آپلود ${filename}: ${err.message}`);
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
    await client.remove(filename);
    console.log(`[FTP] 🗑 Deleted: ${filename}`);
    await ctx.editMessageText(`🗑 فایل ${filename} حذف شد.`);
  } catch (err) {
    console.error(`[FTP] ❌ Error deleting file: ${err.message}`);
    await ctx.reply(`خطا در حذف فایل: ${err.message}`);
  } finally {
    client.close();
  }
});

// ========================================================
//  Webhook Reset to Avoid 409 & Start Bot
// ========================================================
bot.telegram.getWebhookInfo()
  .then(info => {
    console.log("Current webhook:", info.url || "none");
    return bot.telegram.deleteWebhook({ drop_pending_updates: true });
  })
  .then(() => {
    console.log("Webhook deleted. Launching bot...");
    return bot.launch();
  })
  .then(() => console.log("🚀 Telegram‑FTP Bridge Stream mode started..."))
  .catch(err => console.error("❌ Error launching bot:", err));

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
