import express from "express";
import fetch from "node-fetch";
import ftp from "basic-ftp";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

app.post("/upload", async (req, res) => {
  try {
    const fileId = req.body.message.document.file_id;
    const chatId = req.body.message.chat.id;

    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const data = await response.json();
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${data.result.file_path}`;

    const client = new ftp.Client();
    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASS
    });

    const fileName = data.result.file_path.split("/").pop();
    await client.uploadFrom(await fetch(fileUrl).then(r => r.body), process.env.FTP_PATH + fileName);
    client.close();

    setTimeout(async () => {
      await client.access({
        host: process.env.FTP_HOST,
        user: process.env.FTP_USER,
        password: process.env.FTP_PASS
      });
      await client.remove(process.env.FTP_PATH + fileName);
      client.close();
    }, 120000);

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage?chat_id=${chatId}&text=https://dl.yourdomain.com/temp/${fileName}`);

    res.send("✅ Upload success");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error uploading file.");
  }
});

app.get("/", (_, r) => r.send("Bot server is running ✅"));

app.listen(3000);
