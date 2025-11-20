import express from "express";
import multer from "multer";
import { PDFDocument, PDFName, rgb, StandardFonts } from "pdf-lib";

import { addEndlessForgeMetadata } from "./utils/pdfMetadata.js";
import { verifyInternalKey } from "./shared/apiKeyMiddleware.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());

// --------------------- ADVANCED WATERMARK ---------------------
const watermarkUpload = upload.fields([{ name: "pdf", maxCount: 1 }, { name: "image", maxCount: 1 }]);

app.post("/pdf/watermark", verifyInternalKey, watermarkUpload, async (req, res) => {
  try {
    const pdfFile = req.files?.pdf?.[0];
    const imageFile = req.files?.image?.[0];
    if (!pdfFile) return res.status(400).json({ error: "Upload a PDF file" });

    const { text, image, size = 50, color = "#cccccc", position = "center", scale = 1, shadow = false, degrees = 45 } = req.body;

    const pdfDoc = await PDFDocument.load(pdfFile.buffer);
    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const opacity = Math.min(Math.max(parseFloat(req.body.opacity) || 0.3, 0), 1);
    const rotationAngle = parseFloat(degrees) || 0;

    const hexToRgb = (hex) => {
       const bigint = parseInt(hex.replace("#", ""), 16);
       return rgb(((bigint >> 16) & 255) / 255, ((bigint >> 8) & 255) / 255, (bigint & 255) / 255);
    };

    let embeddedImg = null;
    if (imageFile) {
      embeddedImg = imageFile.mimetype.includes("png") ? await pdfDoc.embedPng(imageFile.buffer) : await pdfDoc.embedJpg(imageFile.buffer);
    } else if (image) {
       // Handle URL or Base64
       let imgBuffer;
       if (image.startsWith("data:image")) imgBuffer = Buffer.from(image.split(",")[1], "base64");
       else if (image.startsWith("http")) {
           const response = await fetch(image);
           imgBuffer = Buffer.from(await response.arrayBuffer());
       }
       if (imgBuffer) embeddedImg = image.includes("png") ? await pdfDoc.embedPng(imgBuffer) : await pdfDoc.embedJpg(imgBuffer);
    }

    pages.forEach((page) => {
      const { width, height } = page.getSize();
      let x, y;
      const margin = 30;
      
      if(position === "top-left") { x = margin; y = height - margin; }
      else if(position === "top-right") { x = width - margin; y = height - margin; }
      else if(position === "bottom-left") { x = margin; y = margin; }
      else if(position === "bottom-right") { x = width - margin; y = margin; }
      else { x = width / 2; y = height / 2; }

      if (text) {
        if (shadow) page.drawText(text, { x: x - size/2 + 2, y: y - size/2 - 2, size: parseInt(size), font, color: rgb(0,0,0), opacity: opacity * 0.5, rotate: { type: "degrees", angle: rotationAngle } });
        page.drawText(text, { x: x - size/2, y: y - size/2, size: parseInt(size), font, color: hexToRgb(color), rotate: { type: "degrees", angle: rotationAngle }, opacity: parseFloat(opacity) });
      }
      if (embeddedImg) {
        const w = embeddedImg.width * scale;
        const h = embeddedImg.height * scale;
        page.drawImage(embeddedImg, { x: x - w/2, y: y - h/2, width: w, height: h, opacity: parseFloat(opacity), rotate: { type: "degrees", angle: rotationAngle } });
      }
    });

    await addEndlessForgeMetadata(pdfDoc);
    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="watermarked.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------- GET METADATA ---------------------
app.post("/pdf/metadata/get", verifyInternalKey, upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Upload a PDF file." });
    const pdfDoc = await PDFDocument.load(req.file.buffer, { updateMetadata: false });
    
    // Helper to safely get metadata
    const safeGet = (key) => {
        try {
            const info = pdfDoc.context.lookup(pdfDoc.context.trailer.get(PDFName.of("Info")));
            if(!info) return null;
            const val = info.get(PDFName.of(key));
            return val?.decodeText ? val.decodeText() : (val ? String(val) : null);
        } catch { return null; }
    }

    const metadata = {
      title: pdfDoc.getTitle(),
      author: pdfDoc.getAuthor(),
      subject: pdfDoc.getSubject(),
      producer: pdfDoc.getProducer(),
      custom: { company: safeGet("Company"), manager: safeGet("Manager") }
    };

    res.json({ metadata, pageCount: pdfDoc.getPageCount() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------- SET METADATA ---------------------
app.post("/pdf/metadata/set", verifyInternalKey, upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Upload a PDF" });
    const pdfDoc = await PDFDocument.load(req.file.buffer);
    const { title, author, subject, keywords, producer } = req.body;

    if (title) pdfDoc.setTitle(title);
    if (author) pdfDoc.setAuthor(author);
    if (subject) pdfDoc.setSubject(subject);
    if (keywords) pdfDoc.setKeywords(keywords.split(","));
    if (producer) pdfDoc.setProducer(producer);

    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="metadata-updated.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.send({ status: "OK", service: "Metadata-API" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Metadata API running on port ${PORT}`));