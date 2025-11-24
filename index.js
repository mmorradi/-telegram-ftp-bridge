import express from "express";
import bodyParser from "body-parser";
import TelegramBot from "node-telegram-bot-api";
import ftp from "basic-ftp";
import axios from "axios";
import * as fsPromises from "fs/promises"; // برای توابع promise-based مثل mkdir و unlink
import fs from "fs"; // برای توابع stream-based مثل createWriteStream
import path from "path"; // برای مسیردهی فایل‌ها

// ⬇️ اگر می‌خوای کد رو به صورت محلی تست کنی (روی کامپیوتر خودت)
// ⬇️ باید پکیج dotenv رو نصب کنی و یک فایل .env بسازی
// ⬇️ و متغیرهای محیطی رو اونجا تعریف کنی:
// import dotenv from "dotenv";
// dotenv.config();

const app = express();
app.use(bodyParser.json());

// --- 🔑 متغیرهای محیطی ضروری برای Render ---
// اینها رو باید در بخش "Environment Variables" در تنظیمات سرویس Render خودت اضافه کنی.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FTP_HOST = process.env.FTP_HOST; // مثال: 45.92.92.3
const FTP_USER = process.env.FTP_USER; // مثال: tunerhiv
const FTP_PASS = process.env.FTP_PASS; // مثال: R#oQ0U%6UGW
const FTP_PATH = process.env.FTP_PATH || "/public_html/temp/"; // مسیر پیش‌فرض در FTP، قابل تغییر

// بررسی وجود متغیرهای محیطی حیاتی
if (!TELEGRAM_BOT_TOKEN || !FTP_HOST || !FTP_USER || !FTP_PASS) {
  console.error("❌ خطای پیکربندی: متغیرهای محیطی مورد نیاز پیدا نشدند! " +
                "لطفا TELEGRAM_BOT_TOKEN, FTP_HOST, FTP_USER, FTP_PASS را در Render تنظیم کنید.");
  process.exit(1); // سرویس رو متوقف کن اگر تنظیمات ناقصه
}

// مقداردهی اولیه ربات تلگرام (بدون حالت polling)
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// --- 🌐 Route اصلی برای بررسی وضعیت سرور ---
app.get("/", (req, res) => {
  res.send("TunerHiv server online 🟢 و آماده دریافت فایل!");
});

// --- 📩 Route برای دریافت Webhook تلگرام و پردازش فایل ---
app.post("/upload", async (req, res) => {
  console.log("📩 Telegram webhook hit!");
  const update = req.body;

  // اگر پیامی نبود یا خالی بود، چیزی برای پردازش نیست
  if (!update || !update.message) {
    console.log("❌ بروزرسانی تلگرام حاوی پیام معتبری نبود.");
    return res.status(200).send("No message to process.");
  }

  const message = update.message;
  const chatId = message.chat.id; // ID چت برای ارسال پاسخ به کاربر
  let fileId, fileName, caption;

  // بررسی نوع فایل ارسالی و استخراج اطلاعات
  if (message.document) { // فایل‌های عمومی
    fileId = message.document.file_id;
    fileName = message.document.file_name;
    caption = message.caption;
  } else if (message.photo && message.photo.length > 0) { // عکس‌ها
    // تلگرام چندین سایز عکس می‌فرسته، بزرگترین رو انتخاب می‌کنیم
    const largestPhoto = message.photo[message.photo.length - 1];
    fileId = largestPhoto.file_id;
    fileName = `photo_${fileId}.jpg`; // عکس‌ها نام فایل ندارن، یه نام می‌سازیم
    caption = message.caption;
  } else if (message.video) { // ویدئوها
    fileId = message.video.file_id;
    fileName = message.video.file_name || `video_${fileId}.mp4`;
    caption = message.caption;
  } else if (message.audio) { // فایل‌های صوتی
    fileId = message.audio.file_id;
    fileName = message.audio.file_name || `audio_${fileId}.mp3`;
    caption = message.caption;
  } else if (message.voice) { // پیام‌های صوتی
    fileId = message.voice.file_id;
    fileName = `voice_${fileId}.ogg`;
    caption = message.caption;
  } else if (message.sticker) { // استیکرها (معمولا نیازی به آپلود نیست)
    fileId = message.sticker.file_id;
    fileName = `sticker_${fileId}.webp`;
    caption = message.caption;
  }
  // اگر هیچ فایل یا رسانه‌ای در پیام نبود
  else {
    console.log("🔍 هیچ فایل یا رسانه‌ای در پیام تلگرام پیدا نشد.");
    await bot.sendMessage(chatId, "🤔 هیچ فایل یا رسانه‌ای در پیام شما پیدا نکردم که آپلود کنم.");
    return res.status(200).send("No file to upload.");
  }

  try {
    await bot.sendMessage(chatId, `🚀 در حال آپلود فایل شما: \`${fileName}\` لطفا منتظر بمانید...`, { parse_mode: 'Markdown' });

    // 1. دریافت لینک دانلود فایل از تلگرام
    const fileLink = await bot.getFileLink(fileId);
    console.log(`📥 در حال دانلود از تلگرام: ${fileLink}`);

    // 2. دانلود فایل به یک مسیر موقت روی سرور Render
    const tempFileName = `${Date.now()}_${fileName}`; // نام فایل موقت یونیک برای جلوگیری از تداخل
    const tempFilePath = path.join("/tmp", tempFileName); // Render از /tmp برای فایل‌های موقت استفاده می‌کنه
    
    // اطمینان از وجود دایرکتوری /tmp با استفاده از fsPromises
    await fsPromises.mkdir(path.dirname(tempFilePath), { recursive: true });

    const response = await axios({
      method: 'get',
      url: fileLink,
      responseType: 'stream',
    });

    // ذخیره فایل دانلود شده با استفاده از fs (نسخه سنتی)
    const writer = fs.createWriteStream(tempFilePath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    console.log(`✅ فایل به مسیر موقت دانلود شد: ${tempFilePath}`);

    // 3. آپلود فایل به سرور FTP
    const client = new ftp.Client();
    client.ftp.verbose = true; // فعال کردن لاگ‌های جزئی FTP برای عیب‌یابی

    try {
      await client.access({
        host: FTP_HOST,
        user: FTP_USER,
        password: FTP_PASS,
        secure: false, // ⚠️ اگر هاست FTP شما از FTPS (FTP over SSL/TLS) پشتیبانی می‌کنه، این رو true بذارید.
                       //    در غیر این صورت، false بمونه.
      });
      console.log(`🟢 به FTP متصل شد: ${FTP_HOST}`);

      // اطمینان از وجود مسیر FTP مقصد
      await client.ensureDir(FTP_PATH);
      console.log(`📂 مسیر FTP مقصد ایج: ${FTP_PATH}`);

      // ساخت مسیر نهایی فایل روی FTP (استفاده از / برای جداکننده مسیر در FTP)
      const remoteFilePath = path.join(FTP_PATH, fileName).replace(/\\/g, '/');
      await client.uploadFrom(tempFilePath, remoteFilePath);
      console.log(`📤 فایل به FTP آپلود شد: ${remoteFilePath}`);
      
      await bot.sendMessage(chatId, `✨ فایل با موفقیت آپلود شد!\nآدرس: \`${remoteFilePath}\``, { parse_mode: 'Markdown' });
    } catc (ftpError) {
      console.error("❌ خطای آپلود FTP:", ftpError);
      await bot.sendMessage(chatId, "⚠️ خطایی در آپلود فایل به FTP رخ داد.");
    } finally {
      client.close(); // قطع اتصال FTP
      console.log("FTP connection closed.");
    }

    // 4. حذف فایل موقت از سرور Render با استفاده از fsPromises
    await fsPromises.unlink(tempFilePath);
    console.log(`🗑️ فایل موقت حذف شد: ${tempFilePath}`);

    res.status(200).send("
