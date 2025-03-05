require("dotenv").config();
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const axios = require("axios");
const fs = require("fs");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { Anthropic } = require("@anthropic-ai/sdk");
const { HttpsProxyAgent } = require("https-proxy-agent");

const {
  BlobServiceClient,
  StorageSharedKeyCredential,
} = require("@azure/storage-blob");

const requiredEnvVars = [
  "ANTHROPIC_API_KEY",
  "AZURE_STORAGE_ACCOUNT_NAME",
  "AZURE_STORAGE_ACCOUNT_KEY",
  "AZURE_CONTAINER_NAME",
];
requiredEnvVars.forEach((key) => {
  if (!process.env[key]) {
    console.error(`X Missing environment variable: ${key}`);
    process.exit(1);
  }
});

const app = express();
const PORT = process.env.PORT || 5000;
const upload = multer({ dest: "uploads/" });

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(compression());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use(limiter);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: "https://api.anthropic.com/v1/messages",
  httpAgent: new HttpsProxyAgent("http://rb-proxy-in.bosch.com:8080"),
  timeout: 60000,
});

const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const containerName = process.env.AZURE_CONTAINER_NAME;

const sharedKeyCredential = new StorageSharedKeyCredential(
  accountName,
  accountKey
);
const blobServiceClient = new BlobServiceClient(
  `https://${accountName}.blob.core.windows.net`,
  sharedKeyCredential
);

async function generateSasUrl(blobName) {
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);

  const sasToken = await blobClient.generateSasUrl({
    permissions: "w",
    expiresOn: new Date(new Date().valueOf() + 3600 * 1000),
  });

  return sasToken;
}

const validateRequest = (req, res, next) => {
  const { prompt } = req.body;

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    console.error("Invalid prompt format:", req.body);
    return res.status(400).json({ error: "Invalid prompt format" });
  }

  next();
};

app.get("/test-api", async (req, res) => {
  try {
    const startTime = Date.now();

    const message = await anthropic.messages.create({
      model: "claude-3.5-sonnet",
      max_tokens: 50,
      messages: [{ role: "user", content: "test" }],
    });

    const responseTime = Date.now() - startTime;

    res.setHeader("Content-Type", "application/json");
    res.json({
      status: "success",
      responseTime,
      content: message.content.join(" "),
    });
  } catch (error) {
    console.error("Error during /test-api:", error);
    res.status(500).json({
      status: "error",
      error: error.message,
      code: error.code,
      type: error.type,
    });
  }
});

app.post("/ask", validateRequest, async (req, res) => {
  const { prompt } = req.body;
  const startTime = Date.now();

  try {
    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    return res.json({ response: message.content });
  } catch (error) {
    console.error("Error during /ask:", error);
    return res.status(500).json({
      error: "Failed to fetch response from Claude",
      details: error.message,
    });
  }
});

app.get("/generate-sas-url/:blobName", async (req, res) => {
  try {
    const { blobName } = req.params;
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);

    const sasToken = await blobClient.generateSasUrl({
      permissions: "w",
      expiresOn: new Date(new Date().valueOf() + 3600 * 1000),
    });

    res.json({ sasUrl: sasToken });
  } catch (error) {
    console.error("Error during /generate-sas-url:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/get-images", async (req, res) => {
  try {
    const containerClient = blobServiceClient.getContainerClient(containerName);
    let imageUrls = [];
    let blobCount = 0;

    for await (const blob of containerClient.listBlobsFlat()) {
      blobCount++;

      console.log(`Blob details:`, blob);

      if (blob.name.match(/\.(jpg|jpeg|png|gif|jfif)$/i)) {
        console.log(`Image matched: ${blob.name}`);

        const blobClient = containerClient.getBlobClient(blob.name);

        const sasToken = await blobClient.generateSasUrl({
          permissions: "r",
          expiresOn: new Date(new Date().valueOf() + 3600 * 1000),
        });

        imageUrls.push(sasToken);
      } else {
        console.log(`Blob is not an image: ${blob.name}`);
      }
    }

    console.log(`Total blobs processed: ${blobCount}`);
    console.log(`Total image URLs generated: ${imageUrls.length}`);

    if (imageUrls.length === 0) {
      console.log("No image URLs generated.");
      return res.status(404).json({ error: "No images found" });
    }

    res.json(imageUrls);
  } catch (error) {
    console.error("Error during /get-images:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/extract-text", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file uploaded." });
    }

    const imagePath = req.file.path;
    const imageBuffer = fs.readFileSync(imagePath);

    // Call Azure Computer Vision API for OCR
    const visionResponse = await axios.post(
      `${process.env.AZURE_VISION_ENDPOINT}/vision/v3.2/ocr?language=unk&detectOrientation=true`,
      imageBuffer,
      {
        headers: {
          "Ocp-Apim-Subscription-Key": process.env.AZURE_VISION_KEY,
          "Content-Type": "application/octet-stream",
        },
      }
    );

    // 🛠 FIX: Convert response to a string and find the JSON part
    const rawResponse = visionResponse.data.toString();
    const jsonStartIndex = rawResponse.indexOf("{"); // Find where JSON starts
    const jsonString = rawResponse.substring(jsonStartIndex); // Extract JSON
    const visionData = JSON.parse(jsonString); // Parse JSON

    // ✅ Ensure response has text data
    if (
      !visionData ||
      !visionData.regions ||
      !Array.isArray(visionData.regions)
    ) {
      console.error("Invalid Vision API response.");
      return res
        ?.status(500)
        .json({ error: "Invalid response from Vision API." });
    }

    // ✅ Extract text
    let extractedText = "";
    visionData.regions.forEach((region) => {
      region.lines.forEach((line) => {
        extractedText += line.words.map((word) => word.text).join(" ") + " ";
      });
    });

    extractedText = extractedText.trim();

    if (!extractedText) {
      throw new Error("No text extracted from the image.");
    }

    // Call Azure Translator API
    const translationResponse = await axios.post(
      `${process.env.AZURE_TRANSLATOR_ENDPOINT}/translate?api-version=3.0&to=en`,
      [{ text: extractedText }],
      {
        headers: {
          "Ocp-Apim-Subscription-Key": process.env.AZURE_TRANSLATOR_KEY,
          "Ocp-Apim-Subscription-Region": "eastus",
          "Content-Type": "application/json",
        },
      }
    );

    let rawResponseData = translationResponse.data.toString();

    // Extract the JSON part of the response by finding the first '[' character
    const jsonStart = rawResponseData.indexOf("[");
    if (jsonStart === -1) {
      throw new Error("No JSON found in the response.");
    }

    const jsonStringData = rawResponseData.slice(jsonStart).trim(); // Remove extra spaces or newlines
    const jsonEndIndex = jsonStringData.lastIndexOf("]") + 1;
    const cleanJsonString = jsonStringData.substring(0, jsonEndIndex);

    // Parse the extracted JSON
    const translateData = JSON.parse(cleanJsonString);
    // Check if response contains valid translation
    if (
      !translateData ||
      !Array.isArray(translateData) ||
      translateData.length === 0
    ) {
      throw new Error("Invalid or empty response from Azure Translator API.");
    }

    const firstTranslation = translateData[0]?.translations?.[0];

    if (!firstTranslation || !firstTranslation.text) {
      throw new Error("Translation response does not contain text.");
    }

    const translatedText = firstTranslation.text;

    // Delete the uploaded image after processing
    fs.unlinkSync(imagePath);

    res.json({ extractedText, translatedText });
  } catch (error) {
    console.error(
      "Error processing request:",
      error.response?.data || error.message
    );
    res
      .status(500)
      .json({ error: "An error occurred while processing the image." });
  }
});

app.use((err, req, res, next) => {
  console.error("❌ Server Error:", err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
