import express from "express";
import bodyParser from "body-parser";
import TelegramBot from "node-telegram-bot-api";
import ftp from "basic-ftp";
import axios from "axios";
import * as fsPromises from "fs/promises";
import fs from "fs";
import path from "path";

const app = express();
app.use(bodyParser.json());

// --- 🔑 متغیرهای محیطی ضروری برای Render ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FTP_HOST = process.env.FTP_HOST;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS;
const FTP_PATH = process.env.FTP_PATH || "/public_html/temp/";

// بررسی وجود متغیرهای محیطی حیاتی
if (!TELEGRAM_BOT_TOKEN || !FTP_HOST || !FTP_USER || !FTP_PASS) {
  console.error("❌ خطای پیکربندی: متغیرهای محیطی مورد نیاز پیدا نشدند! " +
                "لطفا TELEGRAM_BOT_TOKEN, FTP_HOST, FTP_USER, FTP_PASS را در Render تنظیم کنید.");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// --- 💾 ذخیره‌سازی موقت اطلاعات فایل‌ها در حافظه ---
// ⚠️ توجه: این Map در صورت ری‌استارت شدن سرویس Render، پاک می‌شود!
// برای پایداری بیشتر، نیاز به دیتابیس خارجی (مثلاً Redis) است.
const uploadedFiles = new Map(); // Key: Telegram file_id, Value: { chatId, fileName, ftpFilePath, uploadTimestamp, timeoutId, originalMessageId, deleteMessageId }

// --- 🌐 Route اصلی برای بررسی وضعیت سرور ---
app.get("/", (req, res) => {
  res.send("TunerHiv server online 🟢 و آماده دریافت فایل!");
});

// --- 📩 Route برای دریافت Webhook تلگرام و پردازش فایل ---
app.post("/upload", async (req, res) => {
  const update = req.body;

  if (!update || (!update.message && !update.callback_query)) {
    console.log("❌ بروزرسانی تلگرام حاوی پیام معتبر یا callback_query نبود.");
    return res.status(200).send("No message or callback_query to process.");
  }

  // 1. **مهمترین گام برای جلوگیری از لوپ:** بلافاصله پاسخ 200 OK را به تلگرام برگردانید.
  // این تضمین می‌کند که تلگرام به‌روزرسانی را دوباره ارسال نمی‌کند.
  res.status(200).send("Webhook received and processing started.");

  // 2. حالا پردازش‌های سنگین‌تر را به صورت آسنکرون انجام دهید.
  if (update.message) {
    processTelegramFile(update.message).catch(error => {
      console.error("❌ خطای کلی در پردازش فایل تلگرام:", error);
      // این خطاها به کاربر از طریق بات اطلاع داده می‌شوند، نه از طریق پاسخ HTTP.
    });
  } else if (update.callback_query) {
    processCallbackQuery(update.callback_query).catch(error => {
      console.error("❌ خطای کلی در پردازش callback_query:", error);
      // این خطاها به کاربر از طریق بات اطلاع داده می‌شوند.
    });
  }
});

// --- ⚙️ تابع کمکی برای انجام عملیات با مکانیزم تکرار ---
async function performWithRetries(action, maxRetries = 3, delayMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await action();
    } catch (error) {
      console.warn(`⚠️ تلاش ${i + 1} ناموفق بود: ${error.message}. در حال تلاش مجدد...`);
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs * (i + 1))); // تاخیر با Exponential Backoff
      } else {
        throw error; // بعد از حداکثر تلاش، خطا را پرتاب کن
      }
    }
  }
}

// --- 📝 تابع پردازش فایل تلگرام (بعد از ارسال پاسخ 200 OK) ---
async function processTelegramFile(message) {
  const chatId = message.chat.id;
  let fileId, fileName, caption;

  if (message.document) {
    fileId = message.document.file_id;
    fileName = message.document.file_name;
    caption = message.caption;
  } else if (message.photo && message.photo.length > 0) {
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
  } else if (message.sticker) {
    fileId = message.sticker.file_id;
    fileName = `sticker_${fileId}.webp`;
    caption = message.caption;
  } else {
    console.log("🔍 هیچ فایل یا رسانه‌ای در پیام تلگرام پیدا نشد.");
    await bot.sendMessage(chatId, "🤔 هیچ فایل یا رسانه‌ای در پیام شما پیدا نکردم که آپلود کنم.");
    return;
  }

  const processingMessage = await bot.sendMessage(chatId, `🚀 در حال پردازش فایل شما: \`${fileName}\` لطفا منتظر بمانید...`, { parse_mode: 'Markdown' });

  try {
    // 1. دریافت لینک دانلود فایل از تلگرام
    const fileLink = await bot.getFileLink(fileId);
    console.log(`📥 در حال دانلود از تلگرام: ${fileLink}`);

    // 2. دانلود فایل به یک مسیر موقت روی سرور Render (با مکانیزم تکرار)
    const tempFileName = `${Date.now()}_${fileName}`;
    const tempFilePath = path.join("/tmp", tempFileName);
    await fsPromises.mkdir(path.dirname(tempFilePath), { recursive: true });

    await performWithRetries(async () => {
      const response = await axios({
        method: 'get',
        url: fileLink,
        responseType: 'stream',
      });
      const writer = fs.createWriteStream(tempFilePath);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      console.log(`✅ فایل به مسیر موقت دانلود شد: ${tempFilePath}`);
    });

    // 3. آپلود فایل به سرور FTP (با مکانیزم تکرار)
    const client = new ftp.Client();
    let ftpFilePath; // این متغیر مسیر نهایی فایل در FTP را نگه می‌دارد

    try {
      await performWithRetries(async () => {
        await client.access({
          host: FTP_HOST,
          user: FTP_USER,
          password: FTP_PASS,
          secure: false, // ⚠️ اگر هاست FTP شما از FTPS (FTP over SSL/TLS) پشتیبانی می‌کنه، این رو true بذارید.
        });
        console.log(`🟢 به FTP متصل شد: ${FTP_HOST}`);
        await client.ensureDir(FTP_PATH);
        console.log(`📂 مسیر FTP مقصد ایجاد/تایید شد: ${FTP_PATH}`);
        ftpFilePath = path.join(FTP_PATH, fileName).replace(/\\/g, '/');
        await client.uploadFrom(tempFilePath, ftpFilePath);
        console.log(`📤 فایل به FTP آپلود شد: ${ftpFilePath}`);
      });

      // 4. حذف فایل موقت از سرور Render
      await fsPromises.unlink(tempFilePath);
      console.log(`🗑️ فایل موقت حذف شد: ${tempFilePath}`);

      // 5. ارسال پیام موفقیت‌آمیز به کاربر با دکمه حذف
      const deleteButton = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "حذف فوری فایل 🗑️", callback_data: `delete_${fileId}` }]
          ]
        }
      };
      const fileUrl = `http://${FTP_HOST}${ftpFilePath.startsWith('/') ? '' : '/'}${ftpFilePath}`; // فرض کنید فایل از طریق http://${FTP_HOST}/public_html/temp/ قابل دسترسه
      const sentMessage = await bot.editMessageText(
        `✨ فایل با موفقیت آپلود شد!\n\n🔗 لینک فایل: \`${fileUrl}\`\n\n_این فایل به صورت خودکار پس از ۱۲ ساعت حذف خواهد شد._`,
        {
          chat_id: chatId,
          message_id: processingMessage.message_id,
          parse_mode: 'Markdown',
          ...deleteButton
        }
      );

      // 6. زمان‌بندی حذف خودکار پس از 12 ساعت (43200000 میلی‌ثانیه)
      const deleteTimeout = setTimeout(async () => {
        try {
          const clientForDelete = new ftp.Client();
          await clientForDelete.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS, secure: false });
          await clientForDelete.remove(ftpFilePath);
          clientForDelete.close();
          await bot.editMessageText(
            `🗑️ فایل \`${fileName}\` به صورت خودکار از FTP حذف شد. (پس از 12 ساعت)`,
            { chat_id: chatId, message_id: sentMessage.message_id, parse_mode: 'Markdown' }
          );
          uploadedFiles.delete(fileId); // حذف از Map
          console.log(`🗑️ فایل ${fileName} به صورت خودکار از FTP حذف شد.`);
        } catch (autoDeleteError) {
          console.error(`❌ خطای حذف خودکار فایل ${fileName} از FTP:`, autoDeleteError);
        }
      }, 12 * 60 * 60 * 1000); // 12 hours

      // 7. ذخیره اطلاعات فایل در Map برای حذف دستی/اتوماتیک
      uploadedFiles.set(fileId, {
        chatId: chatId,
        fileName: fileName,
        ftpFilePath: ftpFilePath,
        uploadTimestamp: Date.now(),
        timeoutId: deleteTimeout,
        originalMessageId: message.message_id,
        deleteMessageId: sentMessage.message_id
      });

    } finally {
      client.close();
      console.log("FTP connection closed.");
    }

  } catch (error) {
    console.error("❌ خطای پردازش فایل:", error);
    await bot.editMessageText(
      `🚨 متاسفانه مشکلی در آپلود فایل شما (\`${fileName}\`) پیش آمد: ${error.message.substring(0, 100)}...`,
      { chat_id: chatId, message_id: processingMessage.message_id, parse_mode: 'Markdown' }
    );
    // اگر فایل موقت ایجاد شده بود، سعی کن حذفش کنی
    if (fs.existsSync(tempFilePath)) {
      await fsPromises.unlink(tempFilePath).catch(e => console.error("خطا در حذف فایل موقت:", e));
    }
  }
}

// --- ⚡️ تابع پردازش Callback Query (برای دکمه حذف) ---
async function processCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;

  if (data.startsWith('delete_')) {
    const fileIdToDelete = data.substring('delete_'.length);
    const fileInfo = uploadedFiles.get(fileIdToDelete);

    if (!fileInfo) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: "⚠️ اطلاعات فایل پیدا نشد یا قبلاً حذف شده است." });
      await bot.editMessageText("⚠️ اطلاعات این فایل پیدا نشد یا قبلاً حذف شده است.", { chat_id: chatId, message_id: messageId });
      return;
    }

    // 1. تلاش برای حذف از FTP
    const client = new ftp.Client();
    try {
      await client.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS, secure: false });
      await client.remove(fileInfo.ftpFilePath);
      client.close();

      // 2. لغو زمان‌بندی حذف خودکار
      clearTimeout(fileInfo.timeoutId);
      uploadedFiles.delete(fileIdToDelete); // حذف از Map

      await bot.answerCallbackQuery(callbackQuery.id, { text: "✅ فایل با موفقیت حذف شد!" });
      await bot.editMessageText(
        `🗑️ فایل \`${fileInfo.fileName}\` با درخواست شما حذف شد.`,
        { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
      );
      console.log(`🗑️ فایل ${fileInfo.fileName} با درخواست کاربر حذف شد.`);

    } catch (deleteError) {
      client.close();
      console.error(`❌ خطای حذف دستی فایل ${fileInfo.fileName} از FTP:`, deleteError);
      await bot.answerCallbackQuery(callbackQuery.id, { text: "❌ مشکلی در حذف فایل پیش آمد." });
      await bot.editMessageText(
        `🚨 مشکلی در حذف فایل \`${fileInfo.fileName}\` پیش آمد: ${deleteError.message.substring(0, 100)}...`,
        { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
      );
    }
  }
}

// --- 🚀 شروع به گوش دادن سرور ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ سرور TunerHiv روی پورت ${PORT} در حال اجراست.`);
  console.log("⚠️ یادآوری: فایل‌های ذخیره شده در حافظه با ری‌استارت سرویس از بین می‌روند.");
});
