// server.js (corregido para Render + arduino-cli local en ./bin y config fija)

const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Supported boards
const SUPPORTED_BOARDS = {
  "arduino:avr:uno": { name: "Arduino Uno", core: "arduino:avr" },

  // ✅ agrega el Nano “simple” (es el que te aparece en logs)
  "arduino:avr:nano": { name: "Arduino Nano", core: "arduino:avr" },

  // ✅ variantes explícitas por bootloader / cpu
  "arduino:avr:nano:cpu=atmega328": { name: "Arduino Nano", core: "arduino:avr" },
  "arduino:avr:nano:cpu=atmega328old": {
    name: "Arduino Nano (Old Bootloader)",
    core: "arduino:avr",
  },

  "arduino:avr:mega:cpu=atmega2560": { name: "Arduino Mega 2560", core: "arduino:avr" },
  "arduino:avr:leonardo": { name: "Arduino Leonardo", core: "arduino:avr" },
  "arduino:avr:micro": { name: "Arduino Micro", core: "arduino:avr" },
};

// Ruta al arduino-cli instalado en el proyecto (NO depende de PATH)
const CLI = path.join(__dirname, "bin", "arduino-cli");
// Config para que use siempre el mismo data dir (recomendado)
const CFG = path.join(__dirname, ".arduino-cli.yaml");

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "1.0.0" });
});

// List available boards
app.get("/boards", (req, res) => {
  const boards = Object.entries(SUPPORTED_BOARDS).map(([fqbn, info]) => ({
    fqbn,
    name: info.name,
  }));
  res.json({ boards });
});

/**
 * Ejecuta arduino-cli con execFile (sin /bin/sh, sin PATH).
 * Devuelve stdout+stderr combinados.
 */
function runArduinoCli(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    // Verificación rápida: el binario debe existir
    if (!fs.existsSync(CLI)) {
      return reject(
        new Error(`arduino-cli no existe en ${CLI}. Revisa tu Build Command en Render.`)
      );
    }

    const finalArgs = fs.existsSync(CFG)
      ? ["--config-file", CFG, ...args]
      : args; // si no existe config, igual intenta

    execFile(
      CLI,
      finalArgs,
      {
        cwd: __dirname,
        timeout: timeoutMs,
        maxBuffer: 50 * 1024 * 1024, // 50MB
      },
      (err, stdout, stderr) => {
        const combined = `${stdout || ""}\n${stderr || ""}`.trim();
        if (err) {
          // Adjunta salida para debugear
          err.combined = combined;
          return reject(err);
        }
        resolve(combined);
      }
    );
  });
}

// Compile endpoint
app.post("/compile", async (req, res) => {
  const { code, fqbn } = req.body;

  if (!code) return res.status(400).json({ success: false, error: "Missing code parameter" });
  if (!fqbn) return res.status(400).json({ success: false, error: "Missing fqbn parameter" });

  if (!SUPPORTED_BOARDS[fqbn]) {
    return res.status(400).json({
      success: false,
      error: `Unsupported board: ${fqbn}. Supported: ${Object.keys(SUPPORTED_BOARDS).join(", ")}`,
    });
  }

  const buildId = uuidv4();
  const buildDir = path.join("/tmp", "arduino-builds", buildId);
  const sketchDir = path.join(buildDir, "sketch");
  const sketchFile = path.join(sketchDir, "sketch.ino");
  const outputDir = path.join(buildDir, "output");

  try {
    fs.mkdirSync(sketchDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(sketchFile, code, "utf-8");

    // Compilar (sin usar "arduino-cli" en shell)
    let output = "";
    try {
      output = await runArduinoCli([
        "compile",
        "--fqbn",
        fqbn,
        "--output-dir",
        outputDir,
        sketchDir,
      ]);
    } catch (compileError) {
      return res.json({
        success: false,
        error: extractErrorMessage(compileError.combined || compileError.message),
        output: compileError.combined || compileError.message,
      });
    }

    // HEX esperado
    const hexFile = path.join(outputDir, "sketch.ino.hex");
    if (!fs.existsSync(hexFile)) {
      return res.json({
        success: false,
        error: "Compilation succeeded but HEX file not found",
        output,
      });
    }

    const hexContent = fs.readFileSync(hexFile, "utf-8");
    const sizeInfo = parseSizeInfo(output);

    return res.json({
      success: true,
      hex: hexContent,
      output,
      size: sizeInfo,
    });
  } catch (error) {
    console.error("Compile error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  } finally {
    // Cleanup
    try {
      fs.rmSync(buildDir, { recursive: true, force: true });
    } catch (e) {
      console.error("Cleanup error:", e);
    }
  }
});

// Extract meaningful error message from compiler output
function extractErrorMessage(output) {
  if (!output) return "Unknown compilation error";

  const lines = output.split("\n");
  const errorLines = lines.filter(
    (line) =>
      line.includes("error:") ||
      line.includes("Error:") ||
      line.includes("undefined reference") ||
      line.includes("fatal error")
  );

  if (errorLines.length > 0) return errorLines.slice(0, 8).join("\n");
  return output.slice(0, 800);
}

// Parse size information from compiler output
function parseSizeInfo(output) {
  const flashMatch = output.match(/Sketch uses (\d+) bytes/);
  const ramMatch = output.match(/Global variables use (\d+) bytes/);

  return {
    flash: flashMatch ? parseInt(flashMatch[1], 10) : null,
    ram: ramMatch ? parseInt(ramMatch[1], 10) : null,
  };
}

// Start server (Render necesita 0.0.0.0)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Arduino Compiler Service running on port ${PORT}`);
  console.log(`Supported boards: ${Object.keys(SUPPORTED_BOARDS).length}`);
  console.log(`CLI path: ${CLI}`);
  console.log(`CFG path: ${CFG} (exists: ${fs.existsSync(CFG)})`);
});
