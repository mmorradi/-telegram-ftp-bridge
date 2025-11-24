import express from "express";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import ftp from "basic-ftp";

dotenv.config();

const app = express();
app.use(express.json());

// -------------------------------
// Telegram Bot setup
// -------------------------------
const TOKEN = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: false });

// مسیر Webhook از تلگرام:
app.post("/upload", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.document) {
      return res.status(200).send("No document");
    }

    const fileId = message.document.file_id;
    const chatId = message.chat.id;

    // دریافت لینک موقت فایل از تلگرام
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

    // اتصال به FTP
    const client = new ftp.Client();
    client.ftp.verbose = false;

    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASS,
      secure: false,
    });

    const fileName = message.document.file_name;
    const remotePath = `${process.env.FTP_PATH}${fileName}`;

    // دریافت فایل از تلگرام و آپلود به هاست آروان:
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    await client.uploadFrom(buffer, remotePath);

    // لینک دانلود نهایی:
    const dlLink = `https://dl.mrdiagcenter.ir/temp/${fileName}`;

    // ارسال لینک به کاربر:
    await bot.sendMessage(chatId, `✅ فایل آماده‌ست:\n${dlLink}`);

    client.close();
    res.send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// -------------------------------
// Health Check
// -------------------------------
app.get("/", (req, res) => {
  res.send("TunerHivBot Server Running 🟢");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
