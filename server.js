const express = require('express');
const cors = require('cors');
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const app = express();
const anthropic = new Anthropic();

app.use(cors());
app.use(express.json());

// Supplier rates by location
const SUPPLIER_RATES = {
  dar_es_salaam: {
    cement_per_bag: 18000,
    steel_per_ton: 1800000,
    timber_per_cbm: 450000,
    labor_per_day: 80000,
  },
  moshi_arusha: {
    cement_per_bag: 19000,
    steel_per_ton: 1900000,
    timber_per_cbm: 480000,
    labor_per_day: 70000,
  },
  zanzibar: {
    cement_per_bag: 22000,
    steel_per_ton: 2100000,
    timber_per_cbm: 520000,
    labor_per_day: 90000,
  },
};

// Claude prompt for analysis
const SYSTEM_PROMPT = `You are a construction cost estimator. Analyze the project and return ONLY valid JSON (no other text).

Return exactly this structure:
{
  "project_name": "string",
  "estimated_area_sqm": 150,
  "foundation_cost_factor": 0.25,
  "structure_cost_factor": 0.50,
  "finishes_cost_factor": 0.25,
  "description": "string"
}

For a "three room villa":
- Area: ~150 sqm
- Foundation: 25% of total
- Structure: 50% of total
- Finishes: 25% of total`;

// API endpoint
app.post('/api/estimate', async (req, res) => {
  try {
    const { projectDescription, location, mode, userInputs } = req.body;

    if (!projectDescription || !location) {
      return res.status(400).json({ error: 'Missing project description or location' });
    }

    // Call Claude
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Analyze this project: "${projectDescription}"`,
        },
      ],
    });

    // Extract JSON from Claude response
    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Invalid Claude response' });
    }

    const analysis = JSON.parse(jsonMatch[0]);
    const rates = SUPPLIER_RATES[location] || SUPPLIER_RATES.dar_es_salaam;

    // Calculate base cost (cement is ~1000 TZS per sqm)
    const baseCost = analysis.estimated_area_sqm * 1000;

    // Apply location multiplier
    const locationMultiplier = location === 'zanzibar' ? 1.25 : location === 'moshi_arusha' ? 1.1 : 1.0;

    // Calculate costs
    const substructureCost = baseCost * analysis.foundation_cost_factor * locationMultiplier;
    const superstructureCost = baseCost * analysis.structure_cost_factor * locationMultiplier;
    const finishesCost = baseCost * analysis.finishes_cost_factor * locationMultiplier;
    const subtotal = substructureCost + superstructureCost + finishesCost;
    const contingency = subtotal * 0.1;
    const total = subtotal + contingency;

    // Generate PDF
    const pdfDir = path.join(__dirname, 'pdfs');
    if (!fs.existsSync(pdfDir)) {
      fs.mkdirSync(pdfDir, { recursive: true });
    }

    const pdfFilename = `estimate_${Date.now()}.pdf`;
    const pdfPath = path.join(pdfDir, pdfFilename);

    const doc = new PDFDocument();
    const stream = fs.createWriteStream(pdfPath);

    doc.pipe(stream);

    // Header
    doc.fontSize(24).font('Helvetica-Bold').text('ArchVision', 50, 40);
    doc.fontSize(12).font('Helvetica').text('Construction Cost Estimator', 50, 70);
    doc.moveTo(50, 90).lineTo(550, 90).stroke();

    // Project info
    doc.fontSize(14).font('Helvetica-Bold').text('Project Estimate', 50, 110);
    doc.fontSize(11).font('Helvetica');
    doc.text(`Project: ${analysis.project_name}`, 50, 135);
    doc.text(`Area: ${analysis.estimated_area_sqm} sqm`, 50, 155);
    doc.text(`Location: ${location.replace('_', ' ').toUpperCase()}`, 50, 175);
    doc.text(`Date: ${new Date().toLocaleDateString()}`, 50, 195);

    // Cost breakdown
    doc.fontSize(12).font('Helvetica-Bold').text('Cost Breakdown', 50, 230);
    doc.fontSize(10).font('Helvetica');

    const costData = [
      ['Substructure (Foundation)', `TZS ${Math.round(substructureCost).toLocaleString()}`],
      ['Superstructure (Walls, Roof)', `TZS ${Math.round(superstructureCost).toLocaleString()}`],
      ['Finishes (Paint, Tiles, etc)', `TZS ${Math.round(finishesCost).toLocaleString()}`],
      ['Subtotal', `TZS ${Math.round(subtotal).toLocaleString()}`],
      ['Contingency (10%)', `TZS ${Math.round(contingency).toLocaleString()}`],
    ];

    let y = 250;
    costData.forEach((row) => {
      doc.text(row[0], 50, y, { width: 350 });
      doc.text(row[1], 400, y, { align: 'right' });
      y += 20;
    });

    // Total
    doc.moveTo(50, y).lineTo(550, y).stroke();
    doc.fontSize(12).font('Helvetica-Bold').text('TOTAL PROJECT COST', 50, y + 10);
    doc.fontSize(16).text(`TZS ${Math.round(total).toLocaleString()}`, 400, y + 10, { align: 'right' });

    // Footer
    doc.fontSize(8).font('Helvetica').text(
      'This estimate is based on standard construction costs in Tanzania. Actual costs may vary based on market conditions and specific requirements.',
      50,
      doc.page.height - 50,
      { width: 500 }
    );

    doc.end();

    // Wait for PDF to be written
    stream.on('finish', () => {
      res.json({
        success: true,
        estimate: {
          project_name: analysis.project_name,
          area_sqm: analysis.estimated_area_sqm,
          location: location,
          costs: {
            substructure: Math.round(substructureCost),
            superstructure: Math.round(superstructureCost),
            finishes: Math.round(finishesCost),
            subtotal: Math.round(subtotal),
            contingency: Math.round(contingency),
            total: Math.round(total),
          },
        },
        pdfUrl: `/pdfs/${pdfFilename}`,
      });
    });

    stream.on('error', (err) => {
      console.error('PDF write error:', err);
      res.status(500).json({ error: 'Failed to generate PDF' });
    });

  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Serve PDFs
app.use('/pdfs', express.static('pdfs'));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ ArchVision server running on port ${PORT}`);
});
