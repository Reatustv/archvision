import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdfkit";
import fs from "fs";
import path from "path";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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

const SYSTEM_PROMPT = `You are a construction cost estimator. Return ONLY valid JSON:
{
  "project_name": "string",
  "estimated_area_sqm": 150,
  "foundation_cost_factor": 0.25,
  "structure_cost_factor": 0.50,
  "finishes_cost_factor": 0.25
}`;

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { projectDescription, location } = req.body;

    if (!projectDescription || !location) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const message = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Analyze: "${projectDescription}"`,
        },
      ],
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return res.status(500).json({ error: "Invalid Claude response" });
    }

    const analysis = JSON.parse(jsonMatch[0]);
    const baseCost = analysis.estimated_area_sqm * 1000;
    const locationMultiplier = location === "zanzibar" ? 1.25 : location === "moshi_arusha" ? 1.1 : 1.0;

    const substructureCost = baseCost * analysis.foundation_cost_factor * locationMultiplier;
    const superstructureCost = baseCost * analysis.structure_cost_factor * locationMultiplier;
    const finishesCost = baseCost * analysis.finishes_cost_factor * locationMultiplier;
    const subtotal = substructureCost + superstructureCost + finishesCost;
    const contingency = subtotal * 0.1;
    const total = subtotal + contingency;

    return res.status(200).json({
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
    });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
