import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("TunerHiv server online 🟢");
});

// مسیر لازم برای webhook تلگرام
app.post("/upload", async (req, res) => {
  console.log("📩 Telegram webhook hit");
  res.status(200).send("Webhook OK ✅");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
