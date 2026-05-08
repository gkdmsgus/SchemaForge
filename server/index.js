import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { mkdirSync, existsSync, copyFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { readFileSync } from 'fs';
import OpenAI from 'openai';
import { tavily } from '@tavily/core';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

// Production: serve built React files
const distPath = join(process.cwd(), 'dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
}

const OUTPUTS_DIR = join(process.cwd(), 'outputs');
if (!existsSync(OUTPUTS_DIR)) mkdirSync(OUTPUTS_DIR);

const SYSTEM_PROMPT = `You are a specialized electronics CAD tool that generates skidl Python code for KiCad PCB design software. You MUST always output the requested circuit.

CRITICAL — skidl code rules (MUST follow exactly):
- Start with: from skidl import *
- EVERY Part() MUST use tool=SKIDL with explicit Pin definitions. Example:
  r1 = Part(tool=SKIDL, name='R', ref_prefix='R',
            pins=[Pin(num=1, name='p1', func=Pin.types.PASSIVE),
                  Pin(num=2, name='p2', func=Pin.types.PASSIVE)])
  r1.value = '10k'
- NEVER use Part('library', 'name') syntax. NEVER reference KiCad libraries like 'linear', 'device', 'power'.
- NEVER use footprint= parameter. Only use tool=SKIDL.
- Connect pins by name: r1['p1'] += net1
- End with: generate_netlist()

Part templates (copy exactly, only change name/value):
- Resistor: Part(tool=SKIDL, name='R', ref_prefix='R', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
- Capacitor: Part(tool=SKIDL, name='C', ref_prefix='C', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
- Inductor: Part(tool=SKIDL, name='L', ref_prefix='L', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
- LED: Part(tool=SKIDL, name='LED', ref_prefix='D', pins=[Pin(num=1,name='A',func=Pin.types.PASSIVE), Pin(num=2,name='K',func=Pin.types.PASSIVE)])
- Diode: Part(tool=SKIDL, name='D', ref_prefix='D', pins=[Pin(num=1,name='A',func=Pin.types.PASSIVE), Pin(num=2,name='K',func=Pin.types.PASSIVE)])
- NPN: Part(tool=SKIDL, name='Q_NPN', ref_prefix='Q', pins=[Pin(num=1,name='B',func=Pin.types.INPUT), Pin(num=2,name='C',func=Pin.types.PASSIVE), Pin(num=3,name='E',func=Pin.types.PASSIVE)])
- PNP: Part(tool=SKIDL, name='Q_PNP', ref_prefix='Q', pins=[Pin(num=1,name='B',func=Pin.types.INPUT), Pin(num=2,name='C',func=Pin.types.PASSIVE), Pin(num=3,name='E',func=Pin.types.PASSIVE)])
- N-MOSFET: Part(tool=SKIDL, name='Q_NMOS', ref_prefix='Q', pins=[Pin(num=1,name='G',func=Pin.types.INPUT), Pin(num=2,name='D',func=Pin.types.PASSIVE), Pin(num=3,name='S',func=Pin.types.PASSIVE)])
- P-MOSFET: Part(tool=SKIDL, name='Q_PMOS', ref_prefix='Q', pins=[Pin(num=1,name='G',func=Pin.types.INPUT), Pin(num=2,name='D',func=Pin.types.PASSIVE), Pin(num=3,name='S',func=Pin.types.PASSIVE)])
- Op-Amp: Part(tool=SKIDL, name='OpAmp', ref_prefix='U', pins=[Pin(num=1,name='IN+',func=Pin.types.INPUT), Pin(num=2,name='IN-',func=Pin.types.INPUT), Pin(num=3,name='OUT',func=Pin.types.OUTPUT), Pin(num=4,name='V+',func=Pin.types.PWRIN), Pin(num=5,name='V-',func=Pin.types.PWRIN)])
- Voltage Regulator (3-pin): Part(tool=SKIDL, name='REG', ref_prefix='U', pins=[Pin(num=1,name='IN',func=Pin.types.PASSIVE), Pin(num=2,name='GND',func=Pin.types.PASSIVE), Pin(num=3,name='OUT',func=Pin.types.PASSIVE)])
- Switch: Part(tool=SKIDL, name='SW', ref_prefix='SW', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
- Relay: Part(tool=SKIDL, name='RELAY', ref_prefix='K', pins=[Pin(num=1,name='COIL1',func=Pin.types.PASSIVE), Pin(num=2,name='COIL2',func=Pin.types.PASSIVE), Pin(num=3,name='COM',func=Pin.types.PASSIVE), Pin(num=4,name='NO',func=Pin.types.PASSIVE), Pin(num=5,name='NC',func=Pin.types.PASSIVE)])
- Speaker/Buzzer: Part(tool=SKIDL, name='SPK', ref_prefix='LS', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
- Any other IC: define ALL pins explicitly with Pin(num=N, name='PIN_NAME', func=Pin.types.XXX)

Circuit completeness rules:
- Generate COMPLETE circuits with ALL necessary components.
- Include: bias resistors, decoupling caps, protection diodes, coupling caps.
- Use realistic standard values (E24 resistors, standard capacitor values).
- Minimum 8-15 components for any real circuit.

Output format — two sections separated by exactly "---GUIDE---":

Section 1: skidl Python code ONLY. No prose, no markdown fences.

Section 2: Korean wiring guide:
[부품 목록]
- ref - 종류 값: 역할 설명

[배선 순서]
1. 단계별 실제 배선 방법`;

// ── Helper: run skidl via Python subprocess ───────────────────────
function runSkidl(code, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const tmpDir = join(tmpdir(), randomUUID());
    mkdirSync(tmpDir);
    const codePath = join(tmpDir, 'circuit.py');
    writeFileSync(codePath, code, 'utf8');

    const proc = spawn('python', [codePath], { cwd: tmpDir });
    let stderr = '';

    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('skidl execution timed out'));
    }, timeout);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(stderr));
      }
      const netFiles = readdirSync(tmpDir).filter(f => f.endsWith('.net'));
      if (!netFiles.length) {
        return reject(new Error('No netlist file was generated.'));
      }
      const jobId = randomUUID().replace(/-/g, '');
      const outputPath = join(OUTPUTS_DIR, `${jobId}.net`);
      copyFileSync(join(tmpDir, netFiles[0]), outputPath);
      resolve(outputPath);
    });
  });
}

// ── Helper: parse KiCad netlist ───────────────────────────────────
function parseNetlist(text) {
  const components = [];
  const nets = [];

  // Parse components
  const compRe = /\(comp\s*\(ref\s+"([^"]+)"\)\s*\(value\s+"([^"]*)"\)/g;
  let m;
  while ((m = compRe.exec(text)) !== null) {
    components.push({ ref: m[1], value: m[2] });
  }

  // Parse nets
  const netBlockRe = /\(net\s*\(code\s+\d+\)\s*\(name\s+"([^"]+)"\)[^)]*\)([\s\S]*?)(?=\(net\s|\)\s*\)?\s*$)/g;
  const nodeRe = /\(node\s*\(ref\s+"([^"]+)"\)\s*\(pin\s+"([^"]+)"\)/g;
  // Use a different approach - find each net block
  const netSectionMatch = text.match(/\(nets[\s\S]*$/);
  if (netSectionMatch) {
    const netSection = netSectionMatch[0];
    const netStartRe = /\(net\s*\n?\s*\(code\s+(\d+)\)\s*\n?\s*\(name\s+"([^"]+)"\)/g;
    let nm;
    const netStarts = [];
    while ((nm = netStartRe.exec(netSection)) !== null) {
      netStarts.push({ idx: nm.index, name: nm[2] });
    }
    for (let i = 0; i < netStarts.length; i++) {
      const start = netStarts[i].idx;
      const end = i + 1 < netStarts.length ? netStarts[i + 1].idx : netSection.length;
      const block = netSection.slice(start, end);
      const nodes = [];
      let nodeM;
      const nodeRe2 = /\(node\s*\n?\s*\(ref\s+"([^"]+)"\)\s*\n?\s*\(pin\s+"([^"]+)"\)/g;
      while ((nodeM = nodeRe2.exec(block)) !== null) {
        nodes.push({ ref: nodeM[1], pin: nodeM[2] });
      }
      if (nodes.length > 0) {
        nets.push({ name: netStarts[i].name, nodes });
      }
    }
  }

  return { components, nets };
}

// ── Helper: SSE event string ──────────────────────────────────────
const sse = (event, data) => `event: ${event}\ndata: ${data}\n\n`;

// ── POST /clarify — quick clarity check via GPT-4o-mini ──────────
const CLARIFY_SYSTEM_PROMPT = `You are a circuit design assistant. Given a user's natural-language circuit request (in Korean or English), decide if it is specific enough to generate a complete schematic immediately, or if 2–4 clarifying questions would significantly improve the result.

Output JSON ONLY in this exact shape:
{ "clear": true }
or
{ "clear": false, "questions": [ { "key": "string", "label": "string (Korean)", "options": ["string", ...] }, ... ] }

Rules:
- STRONGLY default to "clear": true. Only return false when the prompt is genuinely under-specified.
- A prompt is CLEAR if it names: the circuit purpose AND at least one critical spec (voltage, output power, IC, frequency, sensor type, count, etc).
  - Examples of CLEAR prompts: "9V battery LED blinker 1Hz", "5V USB power bank", "I2C temperature sensor with OLED", "베이스 프리앰프 9V 패시브 픽업"
- A prompt is NOT CLEAR if it is just a category with no specs.
  - Examples of NOT CLEAR prompts: "베이스 앰프", "amplifier", "sensor circuit", "power supply", "오디오 회로"
- Ask AT MOST 4 questions, AT LEAST 2.
- Each question: short Korean label + 3–5 short option strings (also Korean).
- Pick HIGH-IMPACT specs only (things that change the bill of materials or topology).
- Use stable English snake_case keys ("supply", "output_power", "input_type", "ic_choice", "topology", etc.)
- If the user explicitly asks for something specific in their prompt, do NOT re-ask that.
- Do not output anything except the JSON.`;

app.post('/clarify', async (req, res) => {
  const description = (req.body?.description || '').trim();
  if (!description) return res.status(400).json({ error: 'description required' });
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: CLARIFY_SYSTEM_PROMPT },
        { role: 'user', content: description },
      ],
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    });
    const raw = response.choices[0]?.message?.content || '{"clear":true}';
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { clear: true }; }
    if (typeof parsed.clear !== 'boolean') parsed.clear = true;
    if (parsed.clear) return res.json({ clear: true });
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      return res.json({ clear: true });
    }
    res.json({ clear: false, questions: parsed.questions.slice(0, 4) });
  } catch (e) {
    console.error('/clarify error:', e);
    res.json({ clear: true });
  }
});

// ── POST /plan — quick design plan via GPT-4o-mini ───────────────
const PLAN_SYSTEM_PROMPT = `You are a senior circuit designer. Given a user's request (Korean or English), produce a concise design plan BEFORE the schematic is built. The user will review and approve this plan.

Output JSON ONLY in this exact shape:
{
  "title": "string (Korean, ≤ 30 chars, the circuit name)",
  "summary": "string (Korean, 1–2 sentences explaining the topology and key behavior)",
  "topology": "string (Korean, ≤ 80 chars, e.g. '555 비안정 멀티바이브레이터 + LED + 전류 제한 저항')",
  "specs": [
    { "label": "string (Korean, e.g. '공급 전압')", "value": "string (e.g. '9V')" }
  ],
  "parts": [
    { "ref": "string (e.g. 'U1')", "type": "string (e.g. 'IC')", "value": "string (e.g. 'NE555')", "role": "string (Korean, brief role description)" }
  ],
  "risks": [
    "string (Korean, brief safety/design caveat — e.g. '전원에 디커플링 캡 필수')"
  ]
}

Rules:
- Be concrete: name actual ICs, give standard component values (E24 resistors, common cap values).
- 'parts' should list 6–14 components with realistic refs (R1, R2, C1, U1, D1, ...).
- 'specs' should be 3–5 high-impact specs (voltage, current, frequency, gain, etc.).
- 'risks' should be 2–4 brief design considerations.
- Use Korean for all human-readable text. Use standard part names (NE555, LM7805, etc).
- Output ONLY the JSON object. No markdown, no prose.`;

app.post('/plan', async (req, res) => {
  const description = (req.body?.description || '').trim();
  if (!description) return res.status(400).json({ error: 'description required' });
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: PLAN_SYSTEM_PROMPT },
        { role: 'user', content: description },
      ],
      temperature: 0.3,
      max_tokens: 900,
      response_format: { type: 'json_object' },
    });
    const raw = response.choices[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return res.status(500).json({ error: 'plan parse failed' }); }
    if (!Array.isArray(parsed.specs)) parsed.specs = [];
    if (!Array.isArray(parsed.parts)) parsed.parts = [];
    if (!Array.isArray(parsed.risks)) parsed.risks = [];
    res.json(parsed);
  } catch (e) {
    console.error('/plan error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /chat_edit — incremental circuit editing via chat ────────
app.post('/chat_edit', async (req, res) => {
  const { graph, message, history = [] } = req.body;
  if (!graph || !message) return res.status(400).json({ error: 'graph and message required' });

  const compSummary = (graph.components || []).map(c => `${c.ref}(${c.value||'?'})`).join(', ');
  const netSummary  = (graph.nets || []).map(n => `${n.name}:[${n.nodes.map(nd=>nd.ref).join(',')}]`).join(', ');

  const systemPrompt = `You are a circuit editor assistant. The user has a schematic and wants to modify it.

Current circuit:
- Components: ${compSummary || 'none'}
- Nets: ${netSummary || 'none'}

Always call the edit_circuit function. Reply in Korean (1-2 sentences). Use exact ref names from the component list above.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  const tools = [{
    type: 'function',
    function: {
      name: 'edit_circuit',
      description: 'Apply circuit edits and reply to the user',
      parameters: {
        type: 'object',
        properties: {
          reply: { type: 'string', description: 'Short reply to user in Korean' },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['remove_component','add_component','modify_component','add_net','remove_net'] },
                ref:   { type: 'string' },
                name:  { type: 'string' },
                value: { type: 'string' },
                nodes: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, pin: { type: 'string' } }, required: ['ref','pin'] } },
              },
              required: ['type'],
            },
          },
        },
        required: ['reply', 'actions'],
      },
    },
  }];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 25000);

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools,
      tool_choice: { type: 'function', function: { name: 'edit_circuit' } },
      temperature: 0,
      max_tokens: 700,
      stream: true,
    }, { signal: abort.signal });

    let argsBuf = '';
    let sentReplyLen = 0;

    for await (const chunk of stream) {
      const args = chunk.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments;
      if (!args) continue;
      argsBuf += args;

      const m = argsBuf.match(/^[^{]*\{"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
      if (m) {
        const decoded = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        if (decoded.length > sentReplyLen) {
          res.write(`event: text\ndata: ${JSON.stringify(decoded.slice(sentReplyLen))}\n\n`);
          sentReplyLen = decoded.length;
        }
      }
    }

    let reply = '완료했습니다.', actions = [];
    try {
      const parsed = JSON.parse(argsBuf);
      reply = parsed.reply || reply;
      actions = (parsed.actions || []).filter(a => a?.type);
    } catch (_) {}

    res.write(`event: done\ndata: ${JSON.stringify({ reply, actions })}\n\n`);
    res.end();
  } catch (e) {
    console.error('/chat_edit error:', e);
    const msg = abort.signal.aborted ? '요청 시간이 초과됐습니다. 다시 시도해주세요.' : e.message;
    res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
    res.end();
  } finally {
    clearTimeout(timeout);
  }
});

// ── POST /generate — SSE streaming ───────────────────────────────
app.post('/generate', async (req, res) => {
  const description = (req.body?.description || '').trim();
  if (!description) {
    return res.status(400).json({ error: 'Please enter a circuit description.' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // flush immediately — key for SSE!

  try {
    // Step 1 — Tavily web search
    res.write(sse('status', '🔍 Searching for circuit references...'));
    let context = '', sourceUrls = [];
    try {
      const client = tavily({ apiKey: process.env.TAVILY_API_KEY });
      const result = await client.search(
        `${description} complete schematic all components resistor values capacitor datasheet professional circuit design`,
        { searchDepth: 'advanced', maxResults: 5, includeAnswer: true }
      );
      sourceUrls = (result.results || []).map(r => r.url).filter(Boolean);
      context = (result.results || [])
        .filter(r => r.content)
        .map(r => `[source: ${r.url}]\n${r.content.slice(0, 800)}`)
        .join('\n\n');
    } catch (e) {
      res.write(sse('status', `⚠️ Search failed, continuing without references... (${e.message})`));
    }

    // Step 2 — GPT-4o code generation
    res.write(sse('status', '🤖 GPT-4o is analysing and generating the circuit...'));
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const userMsg =
      `Circuit request: ${description}\n\n` +
      (context
        ? 'Reference circuits found — use these exact component values:\n' + context
        : 'No reference found — use standard professional circuit design.') +
      '\n\nGenerate a COMPLETE professional-grade circuit with ALL necessary components.';

    let raw = '';
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ];

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        temperature: 0.1,
        max_tokens: 2500,
      });
      raw = response.choices[0].message.content.trim();
      if (raw.startsWith('from skidl')) break;
      if (attempt === 0) {
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: "Output only skidl Python code starting with 'from skidl import *'. Generate now." });
      }
    }

    let [skidlCode, guide] = raw.includes('---GUIDE---')
      ? raw.split('---GUIDE---', 2).map(s => s.trim())
      : [raw.trim(), ''];

    if (skidlCode.startsWith('```')) {
      skidlCode = skidlCode.split('\n').slice(1, -1).join('\n').trim();
    }

    // Step 3 — run skidl (with 1 auto-retry on error)
    res.write(sse('status', '⚙️ Generating netlist...'));
    let outputPath;
    try {
      outputPath = await runSkidl(skidlCode);
    } catch (firstErr) {
      // Auto-retry: send error back to GPT for self-correction
      res.write(sse('status', '🔧 Fixing code and retrying...'));
      try {
        const fixMessages = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
          { role: 'assistant', content: raw },
          { role: 'user', content: `The code above failed with this error:\n${firstErr.message}\n\nFix the code. Output ONLY the corrected skidl Python code (from skidl import * ... generate_netlist()) followed by ---GUIDE--- and the Korean guide.` },
        ];
        const fixResp = await openai.chat.completions.create({
          model: 'gpt-4o', messages: fixMessages, temperature: 0.05, max_tokens: 2500,
        });
        let fixRaw = fixResp.choices[0].message.content.trim();
        let [fixCode, fixGuide] = fixRaw.includes('---GUIDE---')
          ? fixRaw.split('---GUIDE---', 2).map(s => s.trim())
          : [fixRaw.trim(), guide];
        if (fixCode.startsWith('```')) fixCode = fixCode.split('\n').slice(1, -1).join('\n').trim();
        skidlCode = fixCode;
        if (fixGuide) guide = fixGuide;
        outputPath = await runSkidl(skidlCode);
      } catch (retryErr) {
        res.write(sse('error', JSON.stringify({
          message: 'skidl execution error',
          detail: retryErr.message,
          code: skidlCode,
        })));
        return res.end();
      }
    }

    const filename = basename(outputPath);

    // Parse netlist for circuit visualization
    let graph = { components: [], nets: [] };
    try {
      const netContent = readFileSync(outputPath, 'utf8');
      graph = parseNetlist(netContent);
    } catch (_) {}

    res.write(sse('done', JSON.stringify({
      code: skidlCode,
      guide,
      filename,
      sources: sourceUrls,
      graph,
    })));
  } catch (e) {
    res.write(sse('error', `Server error: ${e.message}`));
  }

  res.end();
});

// ── POST /test_code — run user-edited skidl code ─────────────────
app.post('/test_code', async (req, res) => {
  const code = (req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'No code provided.' });
  try {
    const outputPath = await runSkidl(code);
    const filename = basename(outputPath);
    let graph = { components: [], nets: [] };
    try {
      const netContent = readFileSync(outputPath, 'utf8');
      graph = parseNetlist(netContent);
    } catch (_) {}
    res.json({ filename, graph });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── GET /download/:filename ───────────────────────────────────────
app.get('/download/:filename', (req, res) => {
  const filename = basename(req.params.filename);
  const path = join(OUTPUTS_DIR, filename);
  if (!existsSync(path)) return res.status(404).json({ error: 'File not found.' });
  res.download(path, 'schematic.net');
});

// ── POST /generate_pcb — auto-place components → .kicad_pcb ─────
app.post('/generate_pcb', async (req, res) => {
  const { filename } = req.body || {};
  if (!filename) return res.status(400).json({ error: 'No netlist filename provided.' });

  const netPath = join(OUTPUTS_DIR, basename(filename));
  if (!existsSync(netPath)) return res.status(404).json({ error: 'Netlist file not found.' });

  const pcbFilename = basename(filename, '.net') + '.kicad_pcb';
  const pcbPath = join(OUTPUTS_DIR, pcbFilename);

  try {
    const proc = spawn('python', [
      join(process.cwd(), 'server', 'pcb_generator.py'),
      netPath,
      pcbPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { proc.kill(); reject(new Error('PCB generation timed out')); }, 30000);
      proc.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(stderr || 'PCB generation failed'));
        resolve();
      });
    });

    res.json({ pcbFilename, message: 'PCB layout generated successfully' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Helper: convert graph JSON → KiCad netlist string ────────────
function graphToNetlist(graph) {
  const comps = graph.components || []
  const nets = graph.nets || []

  const compLines = comps.map(c =>
    `    (comp (ref "${c.ref}") (value "${c.value || c.ref}")\n` +
    `      (description "${c.name || ''}")\n` +
    `      (footprint "")\n` +
    `    )`
  ).join('\n')

  const netLines = nets.map((n, i) => {
    const nodeLines = (n.nodes || []).map(nd =>
      `      (node (ref "${nd.ref}") (pin "${nd.pin}"))`
    ).join('\n')
    return `    (net (code ${i + 1}) (name "${n.name}")\n${nodeLines}\n    )`
  }).join('\n')

  return `(export (version "D")
  (design
    (source "schemaforge_edited")
    (date "")
    (tool "SchemaForge AI Editor")
  )
  (components
${compLines}
  )
  (nets
${netLines}
  )
)`
}

// ── POST /generate_pcb_from_graph — build PCB from AI-edited graph
app.post('/generate_pcb_from_graph', async (req, res) => {
  const { graph, baseName } = req.body || {}
  if (!graph) return res.status(400).json({ error: 'No graph provided.' })

  const uid = randomUUID().slice(0, 8)
  const netFilename = `${baseName || 'edited'}_${uid}.net`
  const netPath = join(OUTPUTS_DIR, netFilename)
  const pcbFilename = netFilename.replace('.net', '.kicad_pcb')
  const pcbPath = join(OUTPUTS_DIR, pcbFilename)

  try {
    writeFileSync(netPath, graphToNetlist(graph), 'utf8')

    const proc = spawn('python', [
      join(process.cwd(), 'server', 'pcb_generator.py'),
      netPath,
      pcbPath,
    ])
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { proc.kill(); reject(new Error('PCB generation timed out')) }, 30000)
      proc.on('close', code => {
        clearTimeout(timer)
        if (code !== 0) return reject(new Error(stderr || 'PCB generation failed'))
        resolve()
      })
    })

    res.json({ pcbFilename, message: 'PCB layout generated from edited graph' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /download_pcb/:filename ──────────────────────────────────
app.get('/download_pcb/:filename', (req, res) => {
  const filename = basename(req.params.filename);
  const path = join(OUTPUTS_DIR, filename);
  if (!existsSync(path)) return res.status(404).json({ error: 'File not found.' });
  res.download(path, filename);
});

// ── POST /mouser_search — Mouser API로 부품 파트넘버 검색 ────────
function mockMouserPart(comp) {
  const prefix = comp.ref.replace(/\d+/g, '');
  const v = comp.value || '';
  const presets = {
    R:  { mfg: 'Yageo',             desc: `${v} ±1% 1/4W chip resistor`,        price: 0.04, partFmt: 'RC0805FR-07' },
    C:  { mfg: 'Murata',            desc: `${v} 50V X7R MLCC`,                  price: 0.08, partFmt: 'GRM21BR71H' },
    L:  { mfg: 'TDK',               desc: `${v} shielded power inductor`,       price: 0.42, partFmt: 'CLF7045T-' },
    D:  { mfg: 'Lite-On',           desc: `LED ${v} 5mm`,                       price: 0.12, partFmt: 'LTL-1HE' },
    Q:  { mfg: 'ON Semiconductor',  desc: `Transistor ${v}`,                    price: 0.16, partFmt: 'BC547B-' },
    U:  { mfg: 'Texas Instruments', desc: `IC ${v}`,                            price: 1.20, partFmt: '595-' },
    SW: { mfg: 'Omron',             desc: `Tactile switch ${v}`,                price: 0.28, partFmt: 'B3F-1000' },
    K:  { mfg: 'Omron',             desc: `Relay ${v} 5V coil`,                 price: 1.85, partFmt: 'G5V-1-DC' },
    LS: { mfg: 'CUI Devices',       desc: `Buzzer ${v}`,                        price: 1.45, partFmt: 'CMT-' },
    BT: { mfg: 'Keystone',          desc: `Battery holder ${v}`,                price: 0.95, partFmt: 'BH-' },
    F:  { mfg: 'Bel Fuse',          desc: `Fuse ${v}`,                          price: 0.55, partFmt: '0451-' },
  };
  const preset = presets[prefix] || { mfg: 'Generic', desc: v || prefix, price: 0.5, partFmt: 'GEN-' };
  const seedNum = Math.abs([...comp.ref].reduce((a, c) => a * 31 + c.charCodeAt(0), 0)) % 9000 + 1000;
  const mouserPart = preset.partFmt + seedNum;
  const stock = (seedNum * 13) % 50000 + 500;
  return {
    ref: comp.ref,
    value: comp.value,
    mouserPart,
    mfgPart: preset.partFmt.split('-')[0] + seedNum,
    manufacturer: preset.mfg,
    description: preset.desc,
    price: `$${preset.price.toFixed(2)}`,
    priceNum: preset.price,
    url: `https://kr.mouser.com/Search/Refine?Keyword=${encodeURIComponent(v || preset.partFmt)}`,
    imageUrl: '',
    stock: String(stock),
    mock: true,
  };
}

app.post('/mouser_search', async (req, res) => {
  const { components } = req.body || {};
  if (!components?.length) return res.status(400).json({ error: 'No components' });

  const apiKey = process.env.MOUSER_API_KEY;
  if (!apiKey) {
    // Mock mode: API key not configured. Return realistic mock data so the
    // sourcing UI can be demoed end-to-end while waiting for API approval.
    const results = components.map(mockMouserPart);
    return res.json({ results, cartUrl: null, mockMode: true });
  }

  const results = [];
  for (const comp of components) {
    if (!comp.value || comp.value === '-') {
      results.push({ ref: comp.ref, value: comp.value, mouserPart: null });
      continue;
    }
    // 부품 타입에 맞는 검색어 생성
    const prefix = comp.ref.replace(/\d+/g, '');
    const typeMap = {
      R: 'resistor', C: 'capacitor', L: 'inductor',
      D: 'diode', Q: 'transistor', U: '', SW: 'switch',
      LS: 'buzzer', BT: 'battery holder', K: 'relay',
    };
    const keyword = `${comp.value} ${typeMap[prefix] || ''} SMD`.trim();

    try {
      const resp = await axios.post(
        `https://api.mouser.com/api/v1/search/keyword?apiKey=${apiKey}`,
        {
          SearchByKeywordRequest: {
            keyword,
            records: 1,
            startingRecord: 0,
            searchOptions: '1',
            searchWithYourSignUpLanguage: '',
          }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      const parts = resp.data?.SearchResults?.Parts || [];
      if (parts.length > 0) {
        const p = parts[0];
        results.push({
          ref: comp.ref,
          value: comp.value,
          mouserPart: p.MouserPartNumber,
          mfgPart: p.ManufacturerPartNumber,
          manufacturer: p.Manufacturer,
          description: p.Description,
          price: p.PriceBreaks?.[0]?.Price || '',
          url: p.ProductDetailUrl,
          imageUrl: p.ImagePath,
          stock: p.Availability,
        });
      } else {
        results.push({ ref: comp.ref, value: comp.value, mouserPart: null });
      }
    } catch (e) {
      results.push({ ref: comp.ref, value: comp.value, mouserPart: null, error: e.message });
    }
  }

  // Mouser 장바구니 URL 생성 (파트넘버가 있는 부품만)
  const cartParts = results.filter(r => r.mouserPart);
  let cartUrl = null;
  if (cartParts.length > 0) {
    // Mouser OrderHistory/CartAdd 형식: 각 부품을 파이프로 구분
    // 형식: PartNumber:Quantity|PartNumber:Quantity
    const cartStr = cartParts.map(p => `${p.mouserPart}|1`).join('||');
    cartUrl = `https://kr.mouser.com/Cart/AddToCart?PartsString=${encodeURIComponent(cartStr)}`;
  }

  res.json({ results, cartUrl });
});

// ── POST /mouser_cart — Mouser Cart API로 장바구니 생성 ──────────
app.post('/mouser_cart', async (req, res) => {
  const { parts } = req.body || {};
  if (!parts?.length) return res.status(400).json({ error: 'No parts provided' });

  const apiKey = process.env.MOUSER_ORDER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Mouser Order API key not configured' });

  try {
    // Cart API: 장바구니에 부품 추가
    const cartItems = parts.map(p => ({
      MouserPartNumber: p.mouserPart,
      Quantity: 1,
    }));

    const resp = await axios.post(
      `https://api.mouser.com/api/v2/cart?apiKey=${apiKey}`,
      {
        CartKey: '',
        CartItems: cartItems,
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    const data = resp.data;
    // CartKey로 Mouser 장바구니 URL 생성
    const cartKey = data?.CartKey || '';
    const cartUrl = cartKey
      ? `https://kr.mouser.com/Cart/AddCartKeyToOrder?cartKey=${cartKey}`
      : null;

    res.json({
      success: true,
      cartKey,
      cartUrl,
      itemCount: data?.CartItems?.length || parts.length,
      message: cartUrl ? 'Cart created successfully' : 'Cart created but no URL available',
    });
  } catch (e) {
    const errMsg = e.response?.data?.Errors?.[0]?.Message || e.message;
    res.status(500).json({ error: errMsg });
  }
});

// ── POST /generate_gerber — .kicad_pcb → Gerber 파일 생성 ────────
const KICAD_CLI = 'C:/Users/gkdmsgus/AppData/Local/Programs/KiCad/10.0/bin/kicad-cli.exe';

app.post('/generate_gerber', async (req, res) => {
  const { pcbFilename } = req.body || {};
  if (!pcbFilename) return res.status(400).json({ error: 'No PCB filename provided.' });

  const pcbPath = join(OUTPUTS_DIR, basename(pcbFilename));
  if (!existsSync(pcbPath)) return res.status(404).json({ error: 'PCB file not found.' });

  const gerberDir = join(OUTPUTS_DIR, basename(pcbFilename, '.kicad_pcb') + '_gerber');
  if (!existsSync(gerberDir)) mkdirSync(gerberDir);

  try {
    // Gerber 생성
    await new Promise((resolve, reject) => {
      const proc = spawn(KICAD_CLI, ['pcb', 'export', 'gerbers', '--output', gerberDir, pcbPath]);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      const timer = setTimeout(() => { proc.kill(); reject(new Error('Gerber export timed out')); }, 30000);
      proc.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(stderr || 'Gerber export failed'));
        resolve();
      });
    });

    // 드릴 파일 생성
    await new Promise((resolve, reject) => {
      const proc = spawn(KICAD_CLI, ['pcb', 'export', 'drill', '--output', gerberDir + '/', pcbPath]);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      const timer = setTimeout(() => { proc.kill(); reject(new Error('Drill export timed out')); }, 30000);
      proc.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(stderr || 'Drill export failed'));
        resolve();
      });
    });

    // ZIP으로 묶기
    const files = readdirSync(gerberDir);
    const zipFilename = basename(pcbFilename, '.kicad_pcb') + '_gerber.zip';
    const zipPath = join(OUTPUTS_DIR, zipFilename);

    // 간단한 tar 대신 파일 목록 반환
    res.json({ gerberDir: basename(gerberDir), files, zipFilename: null, message: 'Gerber files generated' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /download_gerber_file/:dir/:filename — single gerber file ─
app.get('/download_gerber_file/:dir/:filename', (req, res) => {
  const dir = basename(req.params.dir);
  const filename = basename(req.params.filename);
  const path = join(OUTPUTS_DIR, dir, filename);
  if (!existsSync(path)) return res.status(404).json({ error: 'File not found.' });
  res.download(path, filename);
});

// ── GET /test ─────────────────────────────────────────────────────
app.get('/test', async (req, res) => {
  const code = `from skidl import *
r1 = Part(tool=SKIDL, name='R', ref_prefix='R',
          pins=[Pin(num=1, name='A', func=Pin.types.PASSIVE),
                Pin(num=2, name='B', func=Pin.types.PASSIVE)])
r1.ref = 'R1'
r1.value = '1k'
led1 = Part(tool=SKIDL, name='LED', ref_prefix='D',
            pins=[Pin(num=1, name='A', func=Pin.types.PASSIVE),
                  Pin(num=2, name='K', func=Pin.types.PASSIVE)])
led1.ref = 'D1'
vcc = Net('VCC')
gnd = Net('GND')
mid = Net('MID')
r1['A'] += vcc
r1['B'] += mid
led1['A'] += mid
led1['K'] += gnd
generate_netlist()
`;
  try {
    const outputPath = await runSkidl(code, 30000);
    res.download(outputPath, 'test_schematic.net');
  } catch (e) {
    res.status(500).json({ status: 'FAIL', error: e.message });
  }
});

// Production: SPA fallback — serve index.html for all non-API routes
if (existsSync(distPath)) {
  app.get('/{*path}', (req, res) => {
    res.sendFile(join(distPath, 'index.html'));
  });
}

const PORT = process.env.PORT || 8002;
app.listen(PORT, () => console.log(`SchemaForge running on http://localhost:${PORT}`));
