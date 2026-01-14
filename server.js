const express = require('express');
const cors = require('cors');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Supported boards
const SUPPORTED_BOARDS = {
  'arduino:avr:uno': { name: 'Arduino Uno', core: 'arduino:avr' },
  'arduino:avr:nano:cpu=atmega328': { name: 'Arduino Nano', core: 'arduino:avr' },
  'arduino:avr:nano:cpu=atmega328old': { name: 'Arduino Nano (Old Bootloader)', core: 'arduino:avr' },
  'arduino:avr:mega:cpu=atmega2560': { name: 'Arduino Mega 2560', core: 'arduino:avr' },
  'arduino:avr:leonardo': { name: 'Arduino Leonardo', core: 'arduino:avr' },
  'arduino:avr:micro': { name: 'Arduino Micro', core: 'arduino:avr' },
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// List available boards
app.get('/boards', (req, res) => {
  const boards = Object.entries(SUPPORTED_BOARDS).map(([fqbn, info]) => ({
    fqbn,
    name: info.name,
  }));
  res.json({ boards });
});

// Compile endpoint
app.post('/compile', async (req, res) => {
  const { code, fqbn } = req.body;

  if (!code) {
    return res.status(400).json({ success: false, error: 'Missing code parameter' });
  }

  if (!fqbn) {
    return res.status(400).json({ success: false, error: 'Missing fqbn parameter' });
  }

  if (!SUPPORTED_BOARDS[fqbn]) {
    return res.status(400).json({ 
      success: false, 
      error: `Unsupported board: ${fqbn}. Supported: ${Object.keys(SUPPORTED_BOARDS).join(', ')}` 
    });
  }

  const buildId = uuidv4();
  const buildDir = path.join('/tmp', 'arduino-builds', buildId);
  const sketchDir = path.join(buildDir, 'sketch');
  const sketchFile = path.join(sketchDir, 'sketch.ino');
  const outputDir = path.join(buildDir, 'output');

  try {
    // Create directories
    fs.mkdirSync(sketchDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    // Write sketch file
    fs.writeFileSync(sketchFile, code);

    // Compile using arduino-cli
    const compileCmd = `arduino-cli compile --fqbn ${fqbn} --output-dir ${outputDir} ${sketchDir} 2>&1`;
    
    let output;
    try {
      output = execSync(compileCmd, { 
        encoding: 'utf-8',
        timeout: 60000, // 60 second timeout
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });
    } catch (compileError) {
      // Compilation failed
      return res.json({
        success: false,
        error: extractErrorMessage(compileError.stdout || compileError.message),
        output: compileError.stdout || compileError.message,
      });
    }

    // Find and read the HEX file
    const hexFile = path.join(outputDir, 'sketch.ino.hex');
    
    if (!fs.existsSync(hexFile)) {
      return res.json({
        success: false,
        error: 'Compilation succeeded but HEX file not found',
        output,
      });
    }

    const hexContent = fs.readFileSync(hexFile, 'utf-8');
    
    // Parse size information from output
    const sizeInfo = parseSizeInfo(output);

    res.json({
      success: true,
      hex: hexContent,
      output,
      size: sizeInfo,
    });

  } catch (error) {
    console.error('Compile error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  } finally {
    // Cleanup build directory
    try {
      fs.rmSync(buildDir, { recursive: true, force: true });
    } catch (e) {
      console.error('Cleanup error:', e);
    }
  }
});

// Extract meaningful error message from compiler output
function extractErrorMessage(output) {
  if (!output) return 'Unknown compilation error';
  
  // Look for error lines
  const lines = output.split('\n');
  const errorLines = lines.filter(line => 
    line.includes('error:') || 
    line.includes('Error:') ||
    line.includes('undefined reference')
  );
  
  if (errorLines.length > 0) {
    return errorLines.slice(0, 5).join('\n');
  }
  
  return output.slice(0, 500);
}

// Parse size information from compiler output
function parseSizeInfo(output) {
  const flashMatch = output.match(/Sketch uses (\d+) bytes/);
  const ramMatch = output.match(/Global variables use (\d+) bytes/);
  
  return {
    flash: flashMatch ? parseInt(flashMatch[1]) : null,
    ram: ramMatch ? parseInt(ramMatch[1]) : null,
  };
}

// Start server
app.listen(PORT, () => {
  console.log(`Arduino Compiler Service running on port ${PORT}`);
  console.log(`Supported boards: ${Object.keys(SUPPORTED_BOARDS).length}`);
});
