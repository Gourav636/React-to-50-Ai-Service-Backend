require("dotenv").config();
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const { Anthropic } = require("@anthropic-ai/sdk");
const { HttpsProxyAgent } = require("https-proxy-agent");
const dns = require("dns");
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
} = require("@azure/storage-blob");

dns.setServers(["8.8.8.8", "1.1.1.1"]);

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

app.use(cors());
app.use(express.json());
app.use(compression());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use(limiter);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: "https://52.152.96.252",
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
  console.log("Validating request: ", req.body);

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    console.error("Invalid prompt format:", req.body);
    return res.status(400).json({ error: "Invalid prompt format" });
  }

  next();
};

app.get("/test-api", async (req, res) => {
  try {
    const startTime = Date.now();
    console.log("Calling Anthropic API for test...");
    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 10,
      messages: [{ role: "user", content: "test" }],
    });

    const responseTime = Date.now() - startTime;
    console.log("API Response: ", message.content);
    res.json({ status: "success", responseTime, content: message.content });
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
  console.log("Received prompt:", prompt);

  try {
    console.log("Calling Anthropic API for user prompt...");
    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    console.log("API Response: ", message.content);
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
    console.log("Generating SAS URL for blob:", blobName);
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);

    const sasToken = await blobClient.generateSasUrl({
      permissions: "w",
      expiresOn: new Date(new Date().valueOf() + 3600 * 1000),
    });

    console.log("Generated SAS URL:", sasToken);
    res.json({ sasUrl: sasToken });
  } catch (error) {
    console.error("Error during /generate-sas-url:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/get-images", async (req, res) => {
  try {
    console.log("Fetching image URLs...");
    const containerClient = blobServiceClient.getContainerClient(containerName);
    let imageUrls = [];
    let blobCount = 0;

    for await (const blob of containerClient.listBlobsFlat()) {
      console.log(`Found blob: ${blob.name}`);
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

app.use((err, req, res, next) => {
  console.error("❌ Server Error:", err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
