import express from "express";
import bodyParser from "body-parser";
import TelegramBot from "node-telegram-bot-api";
import ftp from "basic-ftp";
import axios from "axios";
import * as fsPromises from "fs/promises";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const app = express();
app.use(bodyParser.json());

// --- 🔑 Environment Variables ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FTP_HOST = process.env.FTP_HOST;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS;
const FTP_PATH = process.env.FTP_PATH || "temp";
const PORT = process.env.PORT || 10000;

// --- 🛠 پیش‌شرط‌ها ---
if (!TELEGRAM_BOT_TOKEN || !FTP_HOST || !FTP_USER || !FTP_PASS) {
  console.error("❌ تنظیمات ناقص: لطفاً TELEGRAM_BOT_TOKEN, FTP_HOST, FTP_USER, FTP_PASS را در Render وارد کنید.");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const uploadedFiles = new Map();

// --- 🌐 Route برای سلامت سرور ---
app.get("/", (req, res) => {
  res.send("🟢 TunerHiv Render server online and ready!");
});

// --- 📩 Webhook اصلی ---
app.post("/upload", async (req, res) => {
  const update = req.body;
  if (!update || (!update.message && !update.callback_query)) {
    console.log("❌ بروزرسانی معتبر از تلگرام یافت نشد.");
    return res.status(200).send("Invalid update");
  }
  res.status(200).send("Webhook received.");

  if (update.message)
    processTelegramFile(update.message).catch(err => console.error("❌ خطای آپلود:", err));
  else if (update.callback_query)
    processCallbackQuery(update.callback_query).catch(err => console.error("❌ خطای Callback:", err));
});

// --- ⚙️ Retry Utility ---
async function performWithRetries(action, tries = 3, delayMs = 1000) {
  for (let i = 0; i < tries; i++) {
    try {
      return await action();
    } catch (err) {
      console.warn(`⚠️ تلاش ${i + 1} ناموفق بود (${err.message})`);
      if (i < tries - 1) await new Promise(res => setTimeout(res, delayMs * (i + 1)));
      else throw err;
    }
  }
}

// --- 🧾 پردازش فایل تلگرام ---
async function processTelegramFile(message) {
  const chatId = message.chat.id;
  let fileId, fileName;
  let tempFilePath = null;

  if (message.document) {
    fileId = message.document.file_id;
    fileName = message.document.file_name;
  } else if (message.photo?.length > 0) {
    fileId = message.photo[message.photo.length - 1].file_id;
    fileName = `photo_${fileId}.jpg`;
  } else if (message.video) {
    fileId = message.video.file_id;
    fileName = message.video.file_name || `video_${fileId}.mp4`;
  } else {
    await bot.sendMessage(chatId, "🤔 هیچ فایل قابل آپلود پیدا نشد.");
    return;
  }

  const msg = await bot.sendMessage(chatId, `🚀 در حال پردازش فایل: \`${fileName}\` ...`, { parse_mode: "Markdown" });

  try {
    const fileLink = await bot.getFileLink(fileId);
    console.log(`📥 دانلود از تلگرام: ${fileLink}`);

    tempFilePath = path.join("/tmp", `${Date.now()}_${fileName}`);
    await fsPromises.mkdir(path.dirname(tempFilePath), { recursive: true });

    await performWithRetries(async () => {
      const res = await axios({ method: "get", url: fileLink, responseType: "stream" });
      const writer = fs.createWriteStream(tempFilePath);
      res.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
      console.log("✅ فایل موقت دانلود شد:", tempFilePath);
    });

    // --- آپلود به FTP ---
    const client = new ftp.Client();
    let ftpFilePath;

    try {
      await performWithRetries(async () => {
        await client.access({
          host: FTP_HOST,
          user: FTP_USER,
          password: FTP_PASS,
          secure: false,
        });

        // 🔍 لاگ‌های تشخیصی مسیر FTP
        console.log("🔍 شروع بررسی محیط FTP");
        const pwd = await client.pwd();
        console.log(`📂 موقعیت فعلی FTP (PWD): ${pwd}`);

        try {
          const rootList = await client.list("/");
          console.log("📁 محتویات ریشه (/):");
          rootList.forEach(item => console.log(`  - ${item.name}`));
        } catch (err) {
          console.log("⚠️ دسترسی به / مجاز نیست:", err.message);
        }

        try {
          const testTemp = await client.list("temp");
          console.log("📁 محتویات temp:");
          testTemp.forEach(item => console.log(`  - ${item.name}`));
        } catch (err) {
          console.log("⚠️ پوشه temp هنوز در ریشه دیده نمی‌شود:", err.message);
        }

        console.log(`🔧 مقدار FTP_PATH از ENV: ${FTP_PATH}`);

        await client.ensureDir(FTP_PATH);
        ftpFilePath = path.join(FTP_PATH, fileName).replace(/\\/g, "/");
        console.log(`📤 مسیر نهایی برای آپلود: ${ftpFilePath}`);

        await client.uploadFrom(tempFilePath, ftpFilePath);
        console.log(`✅ فایل با موفقیت روی FTP آپلود شد (${ftpFilePath})`);
      });

      // حذف فایل موقت
      if (fs.existsSync(tempFilePath)) await fsPromises.unlink(tempFilePath);

      // ساخت لینک عمومی
      let cleanedFtpPath = ftpFilePath.replace(/^\/?public_html\//, "");
      const fileUrl = `https://tunerhiv.ir${cleanedFtpPath.startsWith("/") ? "" : "/"}${cleanedFtpPath}`;
      const deleteId = randomUUID();

      const sent = await bot.editMessageText(`✅ فایل *${fileName}* آپلود شد.`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "⬇️ دانلود فایل", url: fileUrl },
              { text: "🗑 حذف فایل", callback_data: `delete_${deleteId}` },
            ],
          ],
        },
      });

      // حذف خودکار پس از ۱۲ ساعت
      const timeoutId = setTimeout(async () => {
        try {
          const delClient = new ftp.Client();
          await delClient.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS, secure: false });
          await delClient.remove(ftpFilePath);
          delClient.close();
          await bot.editMessageText(`🗑 فایل \`${fileName}\` حذف شد.`, {
            chat_id: chatId,
            message_id: sent.message_id,
            parse_mode: "Markdown",
          });
          uploadedFiles.delete(deleteId);
          console.log(`🗑 حذف خودکار ${fileName}`);
        } catch (err) {
          console.error(`❌ خطا در حذف خودکار ${fileName}:`, err);
        }
      }, 12 * 60 * 60 * 1000);

      uploadedFiles.set(deleteId, { fileName, ftpFilePath, timeoutId, messageId: msg.message_id, chatId });
    } finally {
      client.close();
    }
  } catch (err) {
    console.error("❌ خطا در upload:", err);
    await bot.editMessageText(`🚨 خطا در آپلود فایل \`${fileName}\`: ${err.message}`, {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: "Markdown",
    });
    if (fs.existsSync(tempFilePath)) await fsPromises.unlink(tempFilePath);
  }
}

// --- 🔁 Callback Query حذف ---
async function processCallbackQuery(query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  if (data.startsWith("delete_")) {
    const id = data.replace("delete_", "");
    const fileInfo = uploadedFiles.get(id);
    if (!fileInfo) {
      await bot.editMessageText("⚠️ فایل موردنظر پیدا نشد یا قبلاً حذف شده است.", { chat_id: chatId, message_id: messageId });
      return;
    }

    const client = new ftp.Client();
    try {
      await client.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS, secure: false });
      await client.remove(fileInfo.ftpFilePath);
      client.close();
      clearTimeout(fileInfo.timeoutId);
      uploadedFiles.delete(id);

      await bot.editMessageText(`🗑️ فایل \`${fileInfo.fileName}\` حذف شد.`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
      });
    } catch (err) {
      client.close();
      await bot.editMessageText(`🚨 خطا در حذف فایل \`${fileInfo.fileName}\`: ${err.message}`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
      });
    }
  }
}

// --- 🚀 Start Server ---
app.listen(PORT, () => {
  console.log(`✅ TunerHiv server listening on port ${PORT}`);
  console.log("⚠️ فایل‌های Map با هر ری‌استارت پاک می‌شوند.");
});
