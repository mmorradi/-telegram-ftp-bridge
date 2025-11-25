import axios from "axios";
import ftp from "basic-ftp";
import { Telegraf, Markup } from "telegraf";

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ========================= FTP Upload (Stream Mode) =========================
async function uploadToFTP(fileUrl, fileName) {
    const client = new ftp.Client();
    client.ftp.verbose = true;

    const ftpHost = process.env.FTP_HOST;
    const ftpUser = process.env.FTP_USER;
    const ftpPass = process.env.FTP_PASS;
    const ftpPath = process.env.FTP_PATH || "temp";

    try {
        // اتصال و لاگ مسیر جاری
        await client.access({
            host: ftpHost,
            user: ftpUser,
            password: ftpPass,
            secure: false
        });

        const pwd = await client.pwd();
        console.log(`[FTP] Connected. PWD = ${pwd}`);

        const list = await client.list();
        console.log(`[FTP] Directory list:`, list.map(f => f.name));

        const targetPath = `${ftpPath}/${fileName}`;
        console.log(`[FTP] Target path: ${targetPath}`);

        // --- دریافت فایل از تلگرام به صورت استریم ---
        const response = await axios.get(fileUrl, { responseType: "stream" });
        console.log(`[STREAM] Started streaming from Telegram → FTP`);

        // --- ارسال مستقیم Stream به سرور FTP ---
        await client.uploadFrom(response.data, targetPath);
        console.log(`[STREAM] Upload completed: ${targetPath}`);

        // --- ساخت لینک عمومی (حذف public_html) ---
        const fileUrlPublic = `https://tunerhiv.ir/${ftpPath}/${fileName}`;

        await client.close();
        return fileUrlPublic;
    } catch (err) {
        console.error("❌ FTP Upload Error:", err.message);
        throw err;
    }
}

// ========================= Message Handlers =========================
bot.on("document", async (ctx) => {
    const fileName = ctx.message.document.file_name;
    const fileId = ctx.message.document.file_id;
    console.log(`📦 Received: ${fileName}`);

    try {
        const fileInfo = await ctx.telegram.getFile(fileId);
        const telegramFileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;

        // آپلود و ساخت لینک عمومی
        const publicUrl = await uploadToFTP(telegramFileUrl, fileName);
        console.log(`✅ Uploaded Successfully: ${publicUrl}`);

        await ctx.reply(
            `فایل با موفقیت آپلود شد ✅`,
            Markup.inlineKeyboard([
                [Markup.button.url("📥 دانلود فایل", publicUrl)],
                [Markup.button.callback("🗑 حذف فایل", `delete_${fileName}`)]
            ])
        );
    } catch (error) {
        console.error("Upload failed:", error.message);
        ctx.reply("❌ خطا در آپلود فایل به FTP رخ داد.");
    }
});

// ========================= Delete Handler =========================
bot.action(/delete_(.+)/, async (ctx) => {
    const fileName = ctx.match[1];
    console.log(`🧹 حذف فایل درخواست شد: ${fileName}`);

    const client = new ftp.Client();
    try {
        await client.access({
            host: process.env.FTP_HOST,
            user: process.env.FTP_USER,
            password: process.env.FTP_PASS,
            secure: false
        });

        const ftpPath = process.env.FTP_PATH || "temp";
        const targetPath = `${ftpPath}/${fileName}`;

        await client.remove(targetPath);
        console.log(`✅ فایل حذف شد از FTP: ${targetPath}`);
        await ctx.answerCbQuery();
        await ctx.editMessageText(`🗑 فایل از سرور حذف شد.`);

        await client.close();
    } catch (err) {
        console.error("❌ Delete Error:", err.message);
        await ctx.answerCbQuery("خطا در حذف فایل!", { show_alert: true });
    }
});

// ========================= Bot Launch =========================
bot.launch();
console.log("🚀 Telegram‑FTP Bridge Stream mode started...");
