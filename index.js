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
const FTP_PATH = process.env.FTP_PATH || "/temp";
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 10000;

// --- 🛠 پیش‌شرط‌ها ---
if (!TELEGRAM_BOT_TOKEN || !FTP_HOST || !FTP_USER || !FTP_PASS) {
  console.error(
    "❌ خطای پیکربندی: لطفاً TELEGRAM_BOT_TOKEN, FTP_HOST, FTP_USER, FTP_PASS را در Render تنظیم کنید."
  );
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const uploadedFiles = new Map(); // حافظه موقت

// --- 🌐 Route آزمایشی برای بررسی سلامت سرور ---
app.get("/", (req, res) => {
  res.send("🟢 TunerHiv Render server online and ready!");
});

// --- 📩 Webhook اصلی تلگرام ---
app.post("/upload", async (req, res) => {
  const update = req.body;

  if (!update || (!update.message && !update.callback_query)) {
    console.log("❌ بروزرسانی معتبر از تلگرام یافت نشد.");
    return res.status(200).send("Invalid update");
  }

  res.status(200).send("Webhook received."); // پاسخ فوری به تلگرام

  if (update.message) {
    processTelegramFile(update.message).catch((error) =>
      console.error("❌ خطای اصلی در پردازش فایل تلگرام:", error)
    );
  } else if (update.callback_query) {
    processCallbackQuery(update.callback_query).catch((error) =>
      console.error("❌ خطای کلی در پردازش callback_query:", error)
    );
  }
});

// --- ⚙️ تابع کمک‌کننده برای Retry ---
async function performWithRetries(action, maxRetries = 3, delayMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await action();
    } catch (error) {
      console.warn(`⚠️ تلاش ${i + 1} ناموفق بود (${error.message}).`);
      if (i < maxRetries - 1)
        await new Promise((res) => setTimeout(res, delayMs * (i + 1)));
      else throw error;
    }
  }
}

// --- 🧾 پردازش فایل تلگرام ---
async function processTelegramFile(message) {
  const chatId = message.chat.id;
  let fileId, fileName, caption;
  let tempFilePath = null;

  // تشخیص نوع فایل
  if (message.document) {
    fileId = message.document.file_id;
    fileName = message.document.file_name;
    caption = message.caption;
  } else if (message.photo?.length > 0) {
    const largestPhoto = message.photo[message.photo.length - 1];
    fileId = largestPhoto.file_id;
    fileName = `photo_${fileId}.jpg`;
    caption = message.caption;
  } else if (message.video) {
    fileId = message.video.file_id;
    fileName = message.video.file_name || `video_${fileId}.mp4`;
    caption = message.caption;
  } else if (message.audio) {
    fileId = message.audio.file_id;
    fileName = message.audio.file_name || `audio_${fileId}.mp3`;
    caption = message.caption;
  } else if (message.voice) {
    fileId = message.voice.file_id;
    fileName = `voice_${fileId}.ogg`;
    caption = message.caption;
  } else {
    await bot.sendMessage(chatId, "🤔 هیچ فایل قابل آپلود پیدا نشد.");
    return;
  }

  const processingMessage = await bot.sendMessage(
    chatId,
    `🚀 در حال پردازش فایل: \`${fileName}\` ...`,
    { parse_mode: "Markdown" }
  );

  try {
    // --- ۱. گرفتن لینک از تلگرام و دانلود فایل ---
    const fileLink = await bot.getFileLink(fileId);
    console.log(`📥 دانلود از تلگرام: ${fileLink}`);

    const tempFileName = `${Date.now()}_${fileName}`;
    tempFilePath = path.join("/tmp", tempFileName);
    await fsPromises.mkdir(path.dirname(tempFilePath), { recursive: true });

    await performWithRetries(async () => {
      const response = await axios({ method: "get", url: fileLink, responseType: "stream" });
      const writer = fs.createWriteStream(tempFilePath);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
      console.log("✅ فایل موقت دانلود شد:", tempFilePath);
    });

    // --- ۲. آپلود FTP ---
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
        await client.ensureDir(FTP_PATH);
        ftpFilePath = path.join(FTP_PATH, fileName).replace(/\\/g, "/");
        await client.uploadFrom(tempFilePath, ftpFilePath);
        console.log(`📤 آپلود شد: ${ftpFilePath}`);
      });

      // حذف فایل موقت لوکال
      if (fs.existsSync(tempFilePath)) {
        await fsPromises.unlink(tempFilePath);
        console.log("🗑 فایل موقت حذف شد.");
      }

      // --- لینک عمومی و دکمه‌ها ---
      const uniqueDeleteId = randomUUID();

      // ✅ حذف کنترل‌شده public_html از مسیر لینک:
      let cleanedFtpPath = ftpFilePath;
      if (cleanedFtpPath.startsWith("public_html/")) {
        cleanedFtpPath = cleanedFtpPath.substring("public_html/".length);
      } else if (cleanedFtpPath.startsWith("/public_html/")) {
        cleanedFtpPath = cleanedFtpPath.substring("/public_html/".length);
      }

      const fileUrl = `https://tunerhiv.ir${cleanedFtpPath.startsWith("/") ? "" : "/"}${cleanedFtpPath}`;

      // ✉️ پیام نهایی به کاربر
      const sentMessage = await bot.editMessageText(
        `✅ فایل *${fileName}* با موفقیت آپلود شد.`,
        {
          chat_id: chatId,
          message_id: processingMessage.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "⬇️ دانلود فایل", url: fileUrl },
                { text: "🗑 حذف فایل", callback_data: `delete_${uniqueDeleteId}` },
              ],
            ],
          },
        }
      );

      // ⏲ حذف خودکار پس از ۱۲ ساعت
      const deleteTimeout = setTimeout(async () => {
        try {
          const delClient = new ftp.Client();
          await delClient.access({
            host: FTP_HOST,
            user: FTP_USER,
            password: FTP_PASS,
            secure: false,
          });
          await delClient.remove(ftpFilePath);
          delClient.close();

          if (uploadedFiles.has(uniqueDeleteId)) {
            await bot.editMessageText(
              `🗑️ فایل \`${fileName}\` پس از ۱۲ ساعت به‌صورت خودکار حذف شد.`,
              {
                chat_id: chatId,
                message_id: sentMessage.message_id,
                parse_mode: "Markdown",
              }
            );
          }
          uploadedFiles.delete(uniqueDeleteId);
          console.log(`🗑 حذف خودکار: ${fileName}`);
        } catch (err) {
          console.error(`❌ خطا در حذف خودکار ${fileName}:`, err);
        }
      }, 12 * 60 * 60 * 1000);

      uploadedFiles.set(uniqueDeleteId, {
        fileName,
        ftpFilePath,
        timeoutId: deleteTimeout,
        messageId: sentMessage.message_id,
        chatId,
      });
    } finally {
      client.close();
    }
  } catch (error) {
    console.error("❌ خطا در upload:", error);
    await bot.editMessageText(
      `🚨 خطا در آپلود فایل \`${fileName}\`: ${error.message}`,
      { chat_id: chatId, message_id: processingMessage.message_id, parse_mode: "Markdown" }
    );
    if (fs.existsSync(tempFilePath))
      await fsPromises.unlink(tempFilePath).catch((e) => console.error("❌ حذف موقت شکست:", e));
  }
}

// --- 🔁 Callback Query حذف دستی ---
async function processCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;

  await bot.answerCallbackQuery(callbackQuery.id);

  if (data.startsWith("delete_")) {
    const uniqueId = data.replace("delete_", "");
    const fileInfo = uploadedFiles.get(uniqueId);

    if (!fileInfo) {
      await bot.editMessageText("⚠️ فایل موردنظر پیدا نشد یا قبلاً حذف شده است.", {
        chat_id: chatId,
        message_id: messageId,
      });
      return;
    }

    const client = new ftp.Client();
    try {
      await client.access({
        host: FTP_HOST,
        user: FTP_USER,
        password: FTP_PASS,
        secure: false,
      });
      await client.remove(fileInfo.ftpFilePath);
      client.close();

      clearTimeout(fileInfo.timeoutId);
      uploadedFiles.delete(uniqueId);

      await bot.editMessageText(`🗑️ فایل \`${fileInfo.fileName}\` حذف شد.`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
      });
    } catch (err) {
      client.close();
      await bot.editMessageText(
        `🚨 خطا در حذف فایل \`${fileInfo.fileName}\`: ${err.message}`,
        { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" }
      );
    }
  }
}

// --- 🚀 Start Server ---
app.listen(PORT, () => {
  console.log(`✅ TunerHiv server listening on port ${PORT}`);
  console.log("⚠️ فایل‌های Map با ری‌استارت Render پاک می‌شوند.");
});
