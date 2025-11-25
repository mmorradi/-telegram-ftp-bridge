import axios from "axios";
import ftp from "basic-ftp";
import { Telegraf, Markup } from "telegraf";

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ================= FTP client setup =================
async function uploadToFTP(fileUrl, fileName) {
    const client = new ftp.Client();
    client.ftp.verbose = true;

    const ftpHost = process.env.FTP_HOST;
    const ftpUser = process.env.FTP_USER;
    const ftpPass = process.env.FTP_PASS;
    const ftpPath = process.env.FTP_PATH || "temp";

    try {
        await client.access({
            host: ftpHost,
            user: ftpUser,
            password: ftpPass,
            port: 10000,
            secure: false,
        });

        const targetPath = `${ftpPath}/${fileName}`;
        console.log(`[FTP] Target path: ${targetPath}`);

        // --- Stream download from Telegram ---
        const response = await axios.get(fileUrl, { responseType: "stream" });
        console.log(`[STREAM] Started streaming telegram file → FTP`);

        // --- Upload stream directly ---
        await client.uploadFrom(response.data, targetPath);
        console.log(`[STREAM] Upload completed on FTP`);

        // --- Build public URL (without public_html) ---
        const fileUrlPublic = `https://tunerhiv.ir/${ftpPath}/${fileName}`;

        await client.close();
        return fileUrlPublic;
    } catch (err) {
        console.error("❌ FTP Upload Error:", err);
        throw err;
    }
}

// ================= Telegram bot handlers =================
bot.on("document", async (ctx) => {
    const fileName = ctx.message.document.file_name;
    const fileId = ctx.message.document.file_id;
    console.log(`📦 Received file: ${fileName}`);

    try {
        const fileInfo = await ctx.telegram.getFile(fileId);
        const telegramFileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;

        // Upload through stream
        const publicUrl = await uploadToFTP(telegramFileUrl, fileName);

        console.log(`✅ Uploaded: ${publicUrl}`);

        await ctx.reply(
            `فایل آپلود شد ✅`,
            Markup.inlineKeyboard([
                [Markup.button.url("📥 دانلود فایل", publicUrl)],
                [Markup.button.callback("🗑 حذف فایل", `delete_${fileName}`)],
            ])
        );
    } catch (error) {
        console.error("Upload failed:", error);
        ctx.reply("❌ خطا در آپلود فایل به FTP رخ داد.");
    }
});

// ================= Delete handler =================
bot.action(/delete_(.+)/, async (ctx) => {
    const fileName = ctx.match[1];
    console.log(`🧹 درخواست حذف فایل: ${fileName}`);

    const client = new ftp.Client();
    try {
        await client.access({
            host: process.env.FTP_HOST,
            user: process.env.FTP_USER,
            password: process.env.FTP_PASS,
            port: 10000,
            secure: false,
        });

        const ftpPath = process.env.FTP_PATH || "temp";
        const targetPath = `${ftpPath}/${fileName}`;

        await client.remove(targetPath);
        console.log(`✅ فایل حذف شد: ${targetPath}`);
        await ctx.answerCbQuery();
        await ctx.editMessageText(`🗑 فایل حذف شد از سرور.`);

        await client.close();
    } catch (err) {
        console.error("❌ Error deleting file:", err);
        await ctx.answerCbQuery("خطا در حذف فایل!", { show_alert: true });
    }
});

bot.launch();
console.log("🚀 Telegram‑FTP Bridge Stream mode started...");
